/**
 * Shared setup for the tests of a claim reclaim that races `recoverAll()` (COR-1618): a store-backed
 * counter of how often the workflow's one activity ran, an owner that dies before driving the
 * workflow, and an engine that takes the claim over with a services resolver a test can hold.
 */
import type { Storage } from "../../embedded/storage/src/index.ts";
import { yieldToEventLoop } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER } from './workflow-claim-transitions.ts';

/** A promise a test settles, to hold something until it chooses. */
export type Hold = PromiseWithResolvers<void>;

export const CLAIM_RENEW_INTERVAL_MS = 1_000;
export const CLAIM_TTL_MS = 3_000;
export const EXPIRED_AFTER_MS =
  CLAIM_TTL_MS + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS + 1;

/** What the activity records in the store it ran against, and what holds it. */
type ActivityProbe = {
  runs: number;
  /** While set, an activity that has started waits here, so the drive stays "running". */
  hold: Hold | null;
};

const probes = new WeakMap<Storage, ActivityProbe>();

export function probeFor(storage: Storage): ActivityProbe {
  let probe = probes.get(storage);
  if (probe === undefined) {
    probe = { runs: 0, hold: null };
    probes.set(storage, probe);
  }
  return probe;
}

export function countingWorkflow(storage: Storage) {
  return workflow({ name: 'counted' }).execute(async function* (ctx: WorkflowContext) {
    return yield* ctx.run(async () => {
      const probe = probeFor(storage);
      probe.runs++;
      await probe.hold?.promise;
      return 'ran';
    });
  });
}

/** An owner that started the workflow, took its claim, and died before driving it. */
export async function strandWorkflow(
  storage: Storage,
  getNow: () => number,
  workflowId: string,
  dispose: boolean,
): Promise<void> {
  const definition = countingWorkflow(storage);
  const previousOwner = await Engine.create({
    storage,
    workflows: { counted: definition },
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    // The first turn never runs, so the activity has not run anywhere yet.
    inlineLaunchScheduling: 'manual',
  });
  await previousOwner.start('counted', null, { id: workflowId, services: { owner: 'previous' } });
  // A graceful exit releases the claim; a crash leaves it to expire. Either way nothing drives it.
  if (dispose) await previousOwner[Symbol.asyncDispose]();
}

export async function createRecoveringEngine(
  storage: Storage,
  now: number,
  holdFirstResolve: boolean,
) {
  // Calls to `resolveWorkflowServices`, and the hold on the first one.
  const resolver = {
    calls: 0,
    hold: holdFirstResolve ? Promise.withResolvers<void>() : null,
  };
  const engine = await Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    getNow: () => now,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    resolveWorkflowServices: async () => {
      resolver.calls++;
      if (resolver.calls === 1) await resolver.hold?.promise;
      return { status: 'available', services: { owner: 'recovered' } };
    },
  });
  return { engine, resolver };
}

/** Let every other task queued on the event loop run, so a drive that is going to start has. */
export async function letOtherDrivesStart(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await yieldToEventLoop();
}
