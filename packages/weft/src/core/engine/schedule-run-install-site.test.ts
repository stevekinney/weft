/**
 * Where a scheduled run's services and cleanup membership are installed (COR-1408).
 *
 * One writer installs a run's transient state: `startWorkflow`, for the launch that adopts the
 * id, in the same synchronous step that installs the run's checkpoint and before its create batch
 * is awaited. `startScheduledRun` puts nothing in engine memory itself, so these cases pin the two
 * properties that make that safe:
 *
 * - nothing reads `workflowServices` or `workflowsNeedingTerminalCleanup` for the occurrence's id
 *   between the moment `startScheduledRun` is called and the install, so no reader that runs
 *   inside the start can have observed a difference between seeding the entries ahead of the
 *   start and installing them at adoption; and
 * - the extra start state a scheduled launch hands `startWorkflow` is not reachable from any
 *   public start surface, so no caller can have its run join terminal cleanup, or hold services,
 *   by any option it passes.
 *
 * Readers outside the start can still reach the id between where the seed was and the adoption:
 * a terminal operation or a signal that lands while the start is resolving its registration. They
 * are listed, with what each of them sees, in the pull request that moved the install.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import {
  workflow,
  type Checkpoint,
  type EngineOptions,
  type ScheduleState,
  type StartWorkflowOptions,
  type WorkflowContext,
} from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';

const WORKFLOW_ID = 'install-site-run';

type CollectionName = 'workflowServices' | 'workflowsNeedingTerminalCleanup';

/** One observation of a transient collection: a read or a write, of one key or of the whole. */
type Observation = {
  event: 'read' | 'write';
  collection: CollectionName;
  operation: string;
  /** `undefined` for an operation on the whole collection (iteration, size, clear). */
  key: string | undefined;
};

type TimelineEntry =
  | Observation
  | { event: 'called' }
  | { event: 'adopted' }
  | { event: 'committed' }
  | { event: 'finished' };

/** The two collections' reads and writes, in the order the engine made them. */
type Timeline = TimelineEntry[];

class RecordingMap extends Map<string, unknown> {
  readonly #timeline: Timeline;

  constructor(timeline: Timeline) {
    super();
    this.#timeline = timeline;
  }

  #note(event: 'read' | 'write', operation: string, key?: string): void {
    this.#timeline.push({ event, collection: 'workflowServices', operation, key });
  }

  override get(key: string): unknown {
    this.#note('read', 'get', key);
    return super.get(key);
  }

  override has(key: string): boolean {
    this.#note('read', 'has', key);
    return super.has(key);
  }

  override set(key: string, value: unknown): this {
    this.#note('write', 'set', key);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.#note('write', 'delete', key);
    return super.delete(key);
  }

  override clear(): void {
    this.#note('write', 'clear');
    super.clear();
  }

  override forEach(...forEachArguments: Parameters<Map<string, unknown>['forEach']>): void {
    this.#note('read', 'forEach');
    super.forEach(...forEachArguments);
  }

  override keys(): MapIterator<string> {
    this.#note('read', 'keys');
    return super.keys();
  }

  override values(): MapIterator<unknown> {
    this.#note('read', 'values');
    return super.values();
  }

  override entries(): MapIterator<[string, unknown]> {
    this.#note('read', 'entries');
    return super.entries();
  }

  override [Symbol.iterator](): MapIterator<[string, unknown]> {
    this.#note('read', 'iterator');
    return super[Symbol.iterator]();
  }

  override get size(): number {
    this.#note('read', 'size');
    return super.size;
  }
}

class RecordingSet extends Set<string> {
  readonly #timeline: Timeline;

  constructor(timeline: Timeline) {
    super();
    this.#timeline = timeline;
  }

  #note(event: 'read' | 'write', operation: string, key?: string): void {
    this.#timeline.push({
      event,
      collection: 'workflowsNeedingTerminalCleanup',
      operation,
      key,
    });
  }

  override has(key: string): boolean {
    this.#note('read', 'has', key);
    return super.has(key);
  }

  override add(key: string): this {
    this.#note('write', 'add', key);
    return super.add(key);
  }

  override delete(key: string): boolean {
    this.#note('write', 'delete', key);
    return super.delete(key);
  }

  override clear(): void {
    this.#note('write', 'clear');
    super.clear();
  }

  override forEach(...forEachArguments: Parameters<Set<string>['forEach']>): void {
    this.#note('read', 'forEach');
    super.forEach(...forEachArguments);
  }

  override keys(): SetIterator<string> {
    this.#note('read', 'keys');
    return super.keys();
  }

  override values(): SetIterator<string> {
    this.#note('read', 'values');
    return super.values();
  }

  override entries(): SetIterator<[string, string]> {
    this.#note('read', 'entries');
    return super.entries();
  }

  override [Symbol.iterator](): SetIterator<string> {
    this.#note('read', 'iterator');
    return super[Symbol.iterator]();
  }

  override get size(): number {
    this.#note('read', 'size');
    return super.size;
  }
}

/** The checkpoints the engine holds, noting when the occurrence's id is adopted. */
class AdoptionRecordingMap extends Map<string, Checkpoint> {
  readonly #timeline: Timeline;

  constructor(timeline: Timeline) {
    super();
    this.#timeline = timeline;
  }

  override set(key: string, value: Checkpoint): this {
    if (key === WORKFLOW_ID) this.#timeline.push({ event: 'adopted' });
    return super.set(key, value);
  }
}

type Resolution = 'available' | 'unavailable' | 'none';

const RESOLUTIONS: readonly Resolution[] = ['available', 'unavailable', 'none'];

const RESOLUTION_LABELS: Record<Resolution, string> = {
  available: 'available services',
  unavailable: 'unavailable services',
  none: 'no resolver',
};

const OCCURRENCE_SERVICES = { owner: 'the occurrence' };

const parkedOnSignal = (name: string) =>
  workflow({ name }).execute(async function* (context: WorkflowContext) {
    return yield* context.waitForSignal<string>('go');
  });

/** Whether an observation concerns the occurrence's id, or the whole collection that holds it. */
function concernsOccurrence(entry: TimelineEntry): entry is Observation {
  return 'collection' in entry && (entry.key === WORKFLOW_ID || entry.key === undefined);
}

function createScheduleState(): ScheduleState {
  return {
    id: 'install-site-schedule',
    workflowType: WORKFLOW_ID,
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

/**
 * Launch one occurrence on an engine whose two transient collections record every read and write,
 * and report the timeline from the call to the end of the launch. `withStartHeaders` adds an
 * interceptor that gives the run start headers, the one other writer that can join terminal
 * cleanup ahead of the commit.
 */
async function launchObservedOccurrence(resolution: Resolution, withStartHeaders: boolean) {
  const timeline: Timeline = [];
  const storage = new MemoryStorage();
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    resolution === 'none'
      ? undefined
      : () =>
          resolution === 'available'
            ? { status: 'available', services: OCCURRENCE_SERVICES }
            : { status: 'unavailable', reason: 'no services for this occurrence' };
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(resolveWorkflowServices === undefined ? {} : { resolveWorkflowServices }),
  });
  engine.register(parkedOnSignal(WORKFLOW_ID));
  if (withStartHeaders) {
    engine.addInterceptor({
      workflowStart: (interception, next) => {
        interception.headers.set('x-trace', 'the-occurrence');
        next(interception);
      },
    });
  }
  const internals = getInternals(engine);
  internals.workflowServices = new RecordingMap(timeline);
  internals.workflowsNeedingTerminalCleanup = new RecordingSet(timeline);
  internals.checkpoints = new AdoptionRecordingMap(timeline);

  const committedWhen = (operations: readonly BatchOperation[]): boolean =>
    operations.some(
      (operation) => operation.type === 'put' && operation.key === KEYS.scheduleRun(WORKFLOW_ID),
    );
  internals.storage = new Proxy(storage, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (property === 'batch' || property === 'conditionalBatch') {
        return async (...argumentsList: unknown[]) => {
          const operations = (
            property === 'batch' ? argumentsList[0] : argumentsList[1]
          ) as BatchOperation[];
          const result: unknown = await original.apply(target, argumentsList);
          if (committedWhen(operations)) timeline.push({ event: 'committed' });
          return result;
        };
      }
      return original.bind(target);
    },
  });

  timeline.push({ event: 'called' });
  await startScheduledRun(internals, createScheduleState(), createScheduleCallbacks(engine), {
    workflowId: WORKFLOW_ID,
  });
  timeline.push({ event: 'finished' });

  return {
    engine,
    internals,
    timeline,
    async dispose() {
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    },
  };
}

function indexOfEvent(timeline: Timeline, event: TimelineEntry['event']): number {
  return timeline.findIndex((entry) => entry.event === event);
}

describe('where a scheduled run installs its transient state', () => {
  for (const resolution of RESOLUTIONS) {
    it(`reads nothing for the occurrence's id before the install, and installs when the launch adopts the id, before the start batch commits, with ${RESOLUTION_LABELS[resolution]}`, async () => {
      const observed = await launchObservedOccurrence(resolution, false);
      try {
        const { timeline } = observed;
        const called = indexOfEvent(timeline, 'called');
        const adopted = indexOfEvent(timeline, 'adopted');
        const committed = indexOfEvent(timeline, 'committed');
        expect(adopted).toBeGreaterThan(called);
        expect(committed).toBeGreaterThan(adopted);

        const occurrence = timeline.filter(concernsOccurrence);
        const firstInstall = timeline.findIndex(
          (entry, index) => index > called && concernsOccurrence(entry) && entry.event === 'write',
        );

        // The install is part of adopting the id: it follows the adoption with nothing in
        // between, and the create batch has not been committed yet.
        expect(firstInstall).toBe(adopted + 1);
        expect(firstInstall).toBeLessThan(committed);

        // Nothing observes either collection for the id, or iterates either, from the call until
        // the install: there is no entry for a reader to have found, or to have missed.
        const beforeInstall = timeline.slice(called, firstInstall).filter(concernsOccurrence);
        expect(beforeInstall).toEqual([]);

        // The install is the first write to either collection for the id, and the services entry
        // and the membership are written there and nowhere else before the run begins.
        const installed = occurrence.filter((entry) => entry.event === 'write');
        expect(installed[0]).toBeDefined();
        const writesFromTheInstall = timeline
          .slice(firstInstall)
          .filter(concernsOccurrence)
          .filter((entry) => entry.event === 'write')
          .map((entry) => `${entry.collection}.${entry.operation}`);
        expect(writesFromTheInstall.slice(0, resolution === 'available' ? 2 : 1)).toEqual(
          resolution === 'available'
            ? ['workflowServices.set', 'workflowsNeedingTerminalCleanup.add']
            : ['workflowsNeedingTerminalCleanup.add'],
        );
      } finally {
        await observed.dispose();
      }
    });
  }

  for (const resolution of RESOLUTIONS) {
    it(`reads nothing for the occurrence's id before the start batch commits when the run has start headers, with ${RESOLUTION_LABELS[resolution]}`, async () => {
      const observed = await launchObservedOccurrence(resolution, true);
      try {
        const { timeline } = observed;
        const called = indexOfEvent(timeline, 'called');
        const committed = indexOfEvent(timeline, 'committed');

        const beforeCommit = timeline.slice(called, committed).filter(concernsOccurrence);
        // The start itself reads neither collection. Its launch installs the run's state when it
        // adopts the id, and the headers then join the cleanup membership, which the install had
        // already made a no-op, as main's seed had.
        expect(beforeCommit.filter((entry) => entry.event === 'read')).toEqual([]);
        expect(beforeCommit.map((entry) => `${entry.collection}.${entry.operation}`)).toEqual([
          ...(resolution === 'available' ? ['workflowServices.set'] : []),
          'workflowsNeedingTerminalCleanup.add',
          'workflowsNeedingTerminalCleanup.add',
        ]);
      } finally {
        await observed.dispose();
      }
    });
  }

  for (const resolution of RESOLUTIONS.filter((candidate) => candidate === 'available')) {
    it(`holds the occurrence's services by identity once its run begins, with ${RESOLUTION_LABELS[resolution]}`, async () => {
      const observed = await launchObservedOccurrence(resolution, false);
      try {
        await waitForCondition(() => observed.internals.parkedInlineWorkflows.has(WORKFLOW_ID), {
          label: `${WORKFLOW_ID} parked on its signal`,
        });
        expect(observed.internals.workflowServices.get(WORKFLOW_ID)).toBe(OCCURRENCE_SERVICES);
        await observed.engine.signal(WORKFLOW_ID, 'go', 'done');
        expect(await observed.engine.getHandle(WORKFLOW_ID).result()).toBe('done');
      } finally {
        await observed.dispose();
      }
    });
  }
});

describe('what the public start surface cannot do', () => {
  /**
   * `startScheduledRun` hands `startWorkflow` an extra, positional argument that joins the run to
   * terminal cleanup without services. No start option names it, and `Engine.start`,
   * `Engine.prepare` and the entry points built on them forward only the options they were given.
   */
  it('has no start option that joins a run to terminal cleanup', async () => {
    const engine = await Engine.create({ storage: new MemoryStorage(), recover: false });
    engine.register(parkedOnSignal(WORKFLOW_ID));
    const internals = getInternals(engine);
    try {
      // @ts-expect-error `joinTerminalCleanup` is not a start option; a scheduled launch passes it positionally.
      const options: StartWorkflowOptions = { id: WORKFLOW_ID, joinTerminalCleanup: true };

      await engine.start(WORKFLOW_ID, null, options);
      await waitForCondition(() => internals.parkedInlineWorkflows.has(WORKFLOW_ID), {
        label: `${WORKFLOW_ID} parked on its signal`,
      });

      // The run asked for no services, and the unknown option did not make it join.
      expect(internals.workflowsNeedingTerminalCleanup.has(WORKFLOW_ID)).toBe(false);
      expect(internals.workflowServices.has(WORKFLOW_ID)).toBe(false);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('has no prepare option that joins a run to terminal cleanup', async () => {
    const engine = await Engine.create({ storage: new MemoryStorage(), recover: false });
    engine.register(parkedOnSignal(WORKFLOW_ID));
    const internals = getInternals(engine);
    try {
      // @ts-expect-error `joinTerminalCleanup` is not a prepare option either.
      const options: StartWorkflowOptions = { id: WORKFLOW_ID, joinTerminalCleanup: true };

      const prepared = await engine.prepare(WORKFLOW_ID, null, options);

      expect(internals.workflowsNeedingTerminalCleanup.has(WORKFLOW_ID)).toBe(false);
      expect(internals.workflowServices.has(WORKFLOW_ID)).toBe(false);
      await prepared.abandon();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
