/**
 * The durable batch a scheduled occurrence commits with its start (COR-1408).
 *
 * `startScheduledRun` builds the operations that belong to the occurrence (its schedule-run
 * metadata and links, its terminal-cleanup marker, the `workflowHasServices` marker when a
 * services resolution happened, and the schedule state and settled-run delete the caller folds
 * in) and hands them to `startWorkflow`, which commits them in the same batch as the workflow
 * record. Which launch holds an occurrence's services and cleanup membership in memory, and when
 * it installs them, is a separate matter from that batch, and moving it must not change what is
 * written: a fresh process recovering the run tells "never had services" from "had services" by
 * the marker, and finds the cleanup sweep it owes by the cleanup key.
 *
 * The expected lists and digests below are what `startScheduledRun` committed on main (244ef383),
 * in order and byte for byte, before the occurrence's transient state moved into `startWorkflow`.
 * The clock and the UUID source are fixed so that every encoded value is reproducible. This file
 * does not import anything the pull request added, so it passes unchanged against that commit as
 * well.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  workflow,
  type EngineOptions,
  type ScheduleState,
  type WorkflowContext,
} from '../types.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { startScheduledRun } from './schedule-run.ts';

const WORKFLOW_ID = 'batch-run';
const SCHEDULE_ID = 'batch-schedule';
const FIXED_NOW = 1_700_000_000_000;

/**
 * How the services resolver answers: with a value, as unavailable, by throwing (which the
 * occurrence reports as unavailable), or not at all (no resolver, which is also what an engine
 * that runs its workflows in workers reports, and what a schedule whose workflows take no
 * services meets).
 */
type Resolution = 'available' | 'unavailable' | 'throws' | 'none';

const RESOLUTIONS: readonly Resolution[] = ['available', 'unavailable', 'throws', 'none'];

const RESOLUTION_LABELS: Record<Resolution, string> = {
  available: 'available services',
  unavailable: 'unavailable services',
  throws: 'a resolver that throws',
  none: 'no resolver',
};

function createScheduleState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    id: SCHEDULE_ID,
    workflowType: WORKFLOW_ID,
    input: null,
    intervalMs: 60_000,
    status: 'paused',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: null,
    queuedRuns: [],
    ...overrides,
  };
}

/** The operations every start batch for the id carries ahead of the occurrence's own. */
const WORKFLOW_RECORD_OPERATIONS = [
  `put ${KEYS.workflow(WORKFLOW_ID)}`,
  `put ${KEYS.checkpoint(WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityCreated(FIXED_NOW, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityStatus('running', WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityType(WORKFLOW_ID, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityUpdated(FIXED_NOW, WORKFLOW_ID)}`,
  `put ${KEYS.workflowVisibilityManifest(WORKFLOW_ID)}`,
];

/** The operations `buildScheduleRunOperations` produces for an occurrence with no folded-in extras. */
const OCCURRENCE_OPERATIONS = [
  `put ${KEYS.scheduleRun(WORKFLOW_ID)}`,
  `put ${KEYS.scheduleRunLink(WORKFLOW_ID)}`,
  `put ${KEYS.scheduleRunBySchedule(SCHEDULE_ID, WORKFLOW_ID)}`,
  `put ${KEYS.terminalCleanupNeeded(WORKFLOW_ID)}`,
];

const FOLDED_IN_OPERATIONS = [
  `put ${KEYS.schedule(SCHEDULE_ID)}`,
  `delete ${KEYS.scheduleRun('prior-run')}`,
];

const SERVICES_MARKER = `put ${KEYS.workflowHasServices(WORKFLOW_ID)}`;

function expectedBatch(resolution: Resolution, foldedIn: boolean): string[] {
  return [
    ...WORKFLOW_RECORD_OPERATIONS,
    ...OCCURRENCE_OPERATIONS,
    ...(foldedIn ? FOLDED_IN_OPERATIONS : []),
    // Written for every resolution that was attempted, available or not, and last.
    ...(resolution === 'none' ? [] : [SERVICES_MARKER]),
  ];
}

function describeOperation(operation: BatchOperation): string {
  return `${operation.type} ${operation.key}`;
}

/** Launch one occurrence and return the operations of the batch that committed its start. */
async function captureStartBatch(
  resolution: Resolution,
  foldedIn: boolean,
): Promise<readonly BatchOperation[]> {
  // Every UUID the engine draws is a function of how many it drew before it, so each encoded value
  // is the same on every run.
  let drawn = 0;
  const uuids = spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(drawn++).padStart(12, '0')}`,
  );
  const storage = new MemoryStorage();
  const resolveWorkflowServices: EngineOptions['resolveWorkflowServices'] | undefined =
    resolution === 'none'
      ? undefined
      : () => {
          if (resolution === 'throws') throw new Error('the resolver refused this occurrence');
          return resolution === 'available'
            ? { status: 'available', services: { owner: 'the occurrence' } }
            : { status: 'unavailable', reason: 'no services for this occurrence' };
        };
  const engine = await Engine.create({
    storage,
    recover: false,
    getNow: () => FIXED_NOW,
    ...(resolveWorkflowServices === undefined ? {} : { resolveWorkflowServices }),
  });
  engine.register(
    workflow({ name: WORKFLOW_ID }).execute(async function* (context: WorkflowContext) {
      return yield* context.waitForSignal<string>('go');
    }),
  );
  const internals = getInternals(engine);
  const batches: BatchOperation[][] = [];
  internals.storage = new Proxy(storage, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (property === 'batch' || property === 'conditionalBatch') {
        return (...argumentsList: unknown[]) => {
          batches.push(
            (property === 'batch' ? argumentsList[0] : argumentsList[1]) as BatchOperation[],
          );
          return original.apply(target, argumentsList);
        };
      }
      return original.bind(target);
    },
  });
  try {
    const schedule = createScheduleState();
    await startScheduledRun(internals, schedule, createScheduleCallbacks(engine), {
      workflowId: WORKFLOW_ID,
      occurrence: FIXED_NOW,
      ...(foldedIn
        ? {
            scheduleStateAfterStart: createScheduleState({ updatedAt: FIXED_NOW + 1 }),
            completedWorkflowId: 'prior-run',
          }
        : {}),
    });
    const startBatch = batches.find((operations) =>
      operations.some(
        (operation) => operation.type === 'put' && operation.key === KEYS.scheduleRun(WORKFLOW_ID),
      ),
    );
    if (startBatch === undefined) throw new Error('the occurrence committed no start batch');
    return startBatch;
  } finally {
    internals.storage = storage;
    await engine[Symbol.asyncDispose]();
    uuids.mockRestore();
  }
}

/** The SHA-256 of what a put writes, as hex; a delete writes no value. */
function digestOfValue(operation: BatchOperation): string {
  return operation.type === 'put'
    ? createHash('sha256').update(operation.value).digest('hex')
    : 'no value';
}

const EMPTY_VALUE_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * The SHA-256 of the value each operation of the start batch wrote on main, by key. An occurrence
 * writes the same bytes for every resolution, so one table serves them all.
 */
const MAIN_VALUE_DIGESTS: Record<string, string> = {
  [KEYS.workflow(WORKFLOW_ID)]: '608c116f6eff278b2e28f6a55cdb28d3edd00289778b3e61da8547180995afdb',
  [KEYS.checkpoint(WORKFLOW_ID)]:
    '8cca8da6004d6233b1f51dcd774bd7d6f7e887f12d43ba952c376f336c2285c6',
  [KEYS.workflowVisibilityCreated(FIXED_NOW, WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.workflowVisibilityStatus('running', WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.workflowVisibilityType(WORKFLOW_ID, WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.workflowVisibilityUpdated(FIXED_NOW, WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.workflowVisibilityManifest(WORKFLOW_ID)]:
    '73afb59c607fe19c213455abe4b475e5902f7b869d0990f3b688adb83255d26e',
  [KEYS.scheduleRun(WORKFLOW_ID)]:
    '51fb9242c5aa70e04142674694424870349f7bd8efdebcbac48bf722b6aa3827',
  [KEYS.scheduleRunLink(WORKFLOW_ID)]:
    '51fb9242c5aa70e04142674694424870349f7bd8efdebcbac48bf722b6aa3827',
  [KEYS.scheduleRunBySchedule(SCHEDULE_ID, WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.terminalCleanupNeeded(WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.workflowHasServices(WORKFLOW_ID)]: EMPTY_VALUE_DIGEST,
  [KEYS.schedule(SCHEDULE_ID)]: 'eb320cee97dea7f255efc4ebdf98392157748fe5f676c2283a72b6822a061b6b',
};

describe('the start batch of a scheduled occurrence', () => {
  for (const resolution of RESOLUTIONS) {
    for (const foldedIn of [false, true]) {
      it(`commits exactly the operations main committed, with ${RESOLUTION_LABELS[resolution]}${
        foldedIn ? ' and the schedule state and settled run folded in' : ''
      }`, async () => {
        const batch = await captureStartBatch(resolution, foldedIn);

        expect(batch.map(describeOperation)).toEqual(expectedBatch(resolution, foldedIn));
      });
    }
  }

  for (const resolution of RESOLUTIONS) {
    for (const foldedIn of [false, true]) {
      it(`commits the bytes main committed, with ${RESOLUTION_LABELS[resolution]}${
        foldedIn ? ' and the schedule state and settled run folded in' : ''
      }`, async () => {
        const batch = await captureStartBatch(resolution, foldedIn);

        const written = batch.map(
          (operation) => `${describeOperation(operation)} ${digestOfValue(operation)}`,
        );
        const expected = expectedBatch(resolution, foldedIn).map((entry) => {
          const key = entry.slice(entry.indexOf(' ') + 1);
          const digest = entry.startsWith('delete ') ? 'no value' : MAIN_VALUE_DIGESTS[key];
          return `${entry} ${digest}`;
        });
        expect(written).toEqual(expected);
      });
    }
  }

  for (const resolution of RESOLUTIONS) {
    it(`writes each occurrence key once, with presence-only markers, with ${RESOLUTION_LABELS[resolution]}`, async () => {
      const batch = await captureStartBatch(resolution, false);

      const keys = batch.map((operation) => operation.key);
      expect(new Set(keys).size).toBe(keys.length);
      const marker = batch.find(
        (operation) => operation.key === KEYS.workflowHasServices(WORKFLOW_ID),
      );
      expect(marker !== undefined).toBe(resolution !== 'none');
      for (const operation of batch) {
        if (
          operation.type === 'put' &&
          (operation.key === KEYS.workflowHasServices(WORKFLOW_ID) ||
            operation.key === KEYS.terminalCleanupNeeded(WORKFLOW_ID))
        ) {
          expect(operation.value.byteLength).toBe(0);
        }
      }
    });
  }
});
