/**
 * A start's record is the only state the engine keeps for it while it is queued or launching, and
 * every transition takes the record its start made and acts only while that record is still the
 * id's current one (COR-1625). A launch that awaited while a `start-new` replacement recorded its
 * own record under the same id must leave that record alone, whether it hands over, settles its
 * flush, moves its flush to launching, or lets go; otherwise a reclaim replays the replacement while
 * it is still launching, or `engine.get()` misreports it.
 */
import { describe, expect, it } from 'bun:test';

import type { EngineInternals } from './internals.ts';
import {
  handOverPendingLaunch,
  hasQueuedInlineWorkflowStart,
  hasQueuedOrLaunchingInlineWorkflowStart,
  holdsWorkflowExecution,
  letGoOfPendingLaunch,
  recordInlineWorkflowStartLaunching,
  recordInlineWorkflowStartQueued,
  recordLaunchPending,
  settleInlineWorkflowStart,
} from './local-execution.ts';

const WORKFLOW_ID = 'launching-run';

/** Only the fields the record bookkeeping reads. A worker engine has no inline strategy. */
function createMarkerInternals(inlineStrategy: unknown = null): EngineInternals {
  return { inlineStrategy, workflowClaimRegistry: null } as never;
}

const launching = (internals: EngineInternals) =>
  hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID);
const queued = (internals: EngineInternals) => hasQueuedInlineWorkflowStart(internals, WORKFLOW_ID);

describe('a worker launch handing its run over', () => {
  it('settles its own marker', () => {
    const internals = createMarkerInternals();
    const launch = recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, launch);
    expect(launching(internals)).toBe(false);
  });

  it("leaves a same-id replacement's marker, which only the replacement settles", async () => {
    const internals = createMarkerInternals();
    const original = recordLaunchPending(internals, WORKFLOW_ID);
    const replacement = recordLaunchPending(internals, WORKFLOW_ID);

    handOverPendingLaunch(internals, original);
    await letGoOfPendingLaunch(internals, original);
    expect(launching(internals)).toBe(true);

    handOverPendingLaunch(internals, replacement);
    expect(launching(internals)).toBe(false);
  });

  it('settles nothing for a launch that set no marker', () => {
    const internals = createMarkerInternals();
    recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, undefined);
    expect(launching(internals)).toBe(true);
  });
});

describe('an inline launch handing its run over', () => {
  it('leaves the marker to the queue that took it over', () => {
    const internals = createMarkerInternals({});
    const launch = recordLaunchPending(internals, WORKFLOW_ID);
    handOverPendingLaunch(internals, launch);
    expect(launching(internals)).toBe(true);
  });
});

describe("a queued start's flush, when a same-id replacement has recorded since", () => {
  it('settles only its own record, leaving the replacement launching', () => {
    const internals = createMarkerInternals({});
    const old = recordInlineWorkflowStartQueued(internals, WORKFLOW_ID);
    recordLaunchPending(internals, WORKFLOW_ID);
    expect(queued(internals)).toBe(false);

    settleInlineWorkflowStart(internals, old);
    expect(launching(internals)).toBe(true);
    expect(queued(internals)).toBe(false);
  });

  it("moves only its own record to launching, leaving the replacement's queued", () => {
    const internals = createMarkerInternals({});
    const old = recordInlineWorkflowStartQueued(internals, WORKFLOW_ID);
    const replacement = recordInlineWorkflowStartQueued(internals, WORKFLOW_ID);

    recordInlineWorkflowStartLaunching(internals, old);
    expect(queued(internals)).toBe(true);

    recordInlineWorkflowStartLaunching(internals, replacement);
    expect(queued(internals)).toBe(false);
    expect(launching(internals)).toBe(true);
    settleInlineWorkflowStart(internals, replacement);
    expect(launching(internals)).toBe(false);
  });
});

describe('a launch letting go', () => {
  it("leaves a queued start to its flush, which handles that start's failures", async () => {
    const internals = createMarkerInternals({});
    const queuedStart = recordInlineWorkflowStartQueued(internals, WORKFLOW_ID);
    await letGoOfPendingLaunch(internals, queuedStart);
    expect(queued(internals)).toBe(true);
  });

  it('settles its own launching record', async () => {
    const internals = createMarkerInternals({});
    const launch = recordLaunchPending(internals, WORKFLOW_ID);
    await letGoOfPendingLaunch(internals, launch);
    expect(launching(internals)).toBe(false);
  });
});

describe('a launch letting go of the claim it recorded', () => {
  function createInternalsHoldingClaim(release: () => Promise<unknown>): EngineInternals {
    return {
      inlineStrategy: {},
      workflowClaimRegistry: { currentEpoch: () => 4, release },
    } as never;
  }

  it('releases the claim at the epoch the launch recorded, then settles its record', async () => {
    const releases: Array<[string, number]> = [];
    const internals = createInternalsHoldingClaim(async (...args) => {
      releases.push(args as unknown as [string, number]);
    });
    const launch = recordLaunchPending(internals, WORKFLOW_ID);

    await letGoOfPendingLaunch(internals, launch);

    expect(releases).toEqual([[WORKFLOW_ID, 4]]);
    expect(launching(internals)).toBe(false);
  });

  it('settles its record even when the release throws, leaving the claim to expire', async () => {
    const internals = createInternalsHoldingClaim(async () => {
      throw new Error('release failed');
    });
    const launch = recordLaunchPending(internals, WORKFLOW_ID);

    await letGoOfPendingLaunch(internals, launch);

    expect(launching(internals)).toBe(false);
  });
});

describe('holdsWorkflowExecution', () => {
  it('asks a worker engine whether it holds the run in-memory checkpoint', () => {
    const internals = { inlineStrategy: null, checkpoints: new Map([['held-run', {}]]) } as never;

    expect(holdsWorkflowExecution(internals, 'held-run')).toBe(true);
    expect(holdsWorkflowExecution(internals, 'other-run')).toBe(false);
  });
});
