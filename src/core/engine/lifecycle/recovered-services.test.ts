/**
 * Unit tests for the shared `reprovideRecoveredServices` helper — the recovery
 * seam used by BOTH the running-workflow resume path and the delayed-start timer
 * path. Tested directly (rather than only end-to-end) because the delayed-start
 * execution path is timer-bound and not deterministically drivable in-process,
 * and because the error/commit-fault branches need fault injection.
 */

import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { encode } from '../../codec.ts';
import { DevelopmentWarningEvent } from '../../events.ts';
import type { ScheduleState, WorkflowServicesResolverInfo, WorkflowState } from '../../types.ts';
import { reprovideRecoveredServices } from './recovered-services.ts';

type ServicesMap = Map<string, unknown>;

const EMPTY_VALUE = new Uint8Array(0);

function makeState(id = 'run-1', type = 'wf'): WorkflowState {
  return {
    id,
    type,
    status: 'running',
    input: { tenant: 'acme' },
    versionTuple: { workflowVersion: '1' },
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeScheduleState(
  id: string,
  options: { currentWorkflowId?: string; overlap?: ScheduleState['overlap'] } = {},
): ScheduleState {
  return {
    id,
    workflowType: 'wf',
    input: { tenant: 'acme' },
    intervalMs: 60_000,
    status: 'active',
    overlap: options.overlap ?? 'skip',
    backfill: false,
    createdAt: 1,
    updatedAt: 1,
    nextFireAt: 60_001,
    missedFireCount: 0,
    queuedRuns: 0,
    ...(options.currentWorkflowId !== undefined
      ? { currentWorkflowId: options.currentWorkflowId }
      : {}),
  };
}

/**
 * Minimal internals stub: an inline engine with a services map, resolver, and a
 * real {@link MemoryStorage} so the helper's durable "expects services" marker
 * read works. `expectsServices` controls whether the marker is pre-populated —
 * defaults to `true` so resolver-firing branches reach the resolver. Set it to
 * `false` to exercise the no-marker short-circuit.
 */
function makeInternals(options: {
  inline?: boolean;
  resolver?: (
    info: {
      workflowId: string;
      workflowType: string;
      input: unknown;
    } & Pick<WorkflowServicesResolverInfo, 'launchOptions' | 'schedule'>,
  ) =>
    | { status: 'available'; services: unknown }
    | { status: 'unavailable'; reason: string }
    | Promise<
        { status: 'available'; services: unknown } | { status: 'unavailable'; reason: string }
      >;
  services?: ServicesMap;
  expectsServices?: boolean;
  stateId?: string;
}): { internals: never; services: ServicesMap; storage: MemoryStorage } {
  const services: ServicesMap = options.services ?? new Map();
  const storage = new MemoryStorage();
  if (options.expectsServices !== false) {
    void storage.put(KEYS.workflowHasServices(options.stateId ?? 'run-1'), EMPTY_VALUE);
  }
  const internals = {
    inlineStrategy: options.inline === false ? null : {},
    workflowServices: services,
    storage,
    options: { resolveWorkflowServices: options.resolver },
  } as never;
  return { internals, services, storage };
}

const noopCommitError = (): void => {};

describe('reprovideRecoveredServices', () => {
  it('proceeds (false) and stores services when the resolver reports available', async () => {
    const { internals, services } = makeInternals({
      resolver: () => ({ status: 'available', services: { db: 1 } }),
    });
    const failRun = mock(async () => {});

    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);

    expect(stop).toBe(false);
    expect(services.get('run-1')).toEqual({ db: 1 });
    expect(failRun).not.toHaveBeenCalled();
  });

  it('passes the durable launch input to the resolver', async () => {
    let seenInput: unknown;
    const { internals } = makeInternals({
      resolver: (info) => {
        seenInput = info.input;
        return { status: 'available', services: {} };
      },
    });
    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);
    expect(seenInput).toEqual({ tenant: 'acme' });
  });

  it('passes recovered schedule context from schedule-run metadata to the resolver', async () => {
    let seenSchedule: unknown;
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(
      KEYS.scheduleRun('run-1'),
      encode({ id: 'nightly-schedule', occurrence: 1_767_225_600_000 }),
    );
    await storage.put(
      KEYS.schedule('nightly-schedule'),
      encode(makeScheduleState('nightly-schedule', { currentWorkflowId: 'run-1' })),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toEqual({
      id: 'nightly-schedule',
      occurrence: 1_767_225_600_000,
    });
  });

  it('tolerates historical string schedule-run metadata during recovery', async () => {
    let seenSchedule: unknown;
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(KEYS.scheduleRun('run-1'), encode('historical-schedule'));
    await storage.put(
      KEYS.schedule('historical-schedule'),
      encode(makeScheduleState('historical-schedule', { currentWorkflowId: 'run-1' })),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toEqual({ id: 'historical-schedule' });
  });

  it('ignores stale schedule-run metadata when the schedule points at another workflow', async () => {
    let seenSchedule: unknown = 'not-called';
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(
      KEYS.scheduleRun('run-1'),
      encode({ id: 'stale-schedule', occurrence: 1_767_225_600_000 }),
    );
    await storage.put(
      KEYS.schedule('stale-schedule'),
      encode(makeScheduleState('stale-schedule', { currentWorkflowId: 'other-run' })),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toBeUndefined();
  });

  it('ignores malformed schedule-run metadata during services recovery', async () => {
    let seenSchedule: unknown = 'not-called';
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(
      KEYS.scheduleRun('run-1'),
      encode({ id: 'malformed-schedule', occurrence: 1.5 }),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toBeUndefined();
  });

  it('ignores orphaned schedule-run metadata when the schedule record is gone', async () => {
    let seenSchedule: unknown = 'not-called';
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(
      KEYS.scheduleRun('run-1'),
      encode({ id: 'missing-schedule', occurrence: 1_767_225_600_000 }),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toBeUndefined();
  });

  it('accepts allow-overlap schedule-run metadata without currentWorkflowId', async () => {
    let seenSchedule: unknown;
    const { internals, storage } = makeInternals({
      resolver: (info) => {
        seenSchedule = info.schedule;
        return { status: 'available', services: {} };
      },
    });
    await storage.put(
      KEYS.scheduleRun('run-1'),
      encode({ id: 'allow-schedule', occurrence: 1_767_225_600_000 }),
    );
    await storage.put(
      KEYS.schedule('allow-schedule'),
      encode(makeScheduleState('allow-schedule', { overlap: 'allow' })),
    );

    await reprovideRecoveredServices(internals, makeState(), async () => {}, noopCommitError);

    expect(seenSchedule).toEqual({
      id: 'allow-schedule',
      occurrence: 1_767_225_600_000,
    });
  });

  it('stops, fails the run, and emits an actionable warning when the marker exists but no resolver is configured', async () => {
    const { internals } = makeInternals({});
    const failed: Array<[string, Error]> = [];
    const warnings: DevelopmentWarningEvent[] = [];
    const failRun = async (id: string, error: Error): Promise<void> => {
      failed.push([id, error]);
    };

    const stop = await reprovideRecoveredServices(
      internals,
      makeState(),
      failRun,
      noopCommitError,
      (event) => {
        if (event instanceof DevelopmentWarningEvent) {
          warnings.push(event);
        }
      },
    );

    expect(stop).toBe(true);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toBe('run-1');
    expect(failed[0]![1].message).toContain('resolveWorkflowServices');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('run-1');
    expect(warnings[0]!.message).toContain('resolveWorkflowServices');
    expect(warnings[0]!.fieldPaths).toContain('EngineOptions.resolveWorkflowServices');
  });

  it('still stops and records a commit error when missing-resolver failure cannot commit', async () => {
    const { internals } = makeInternals({});
    const failRun = mock(async () => {
      throw new Error('terminal write failed');
    });
    const commitErrors: Array<[string, unknown, string]> = [];

    const stop = await reprovideRecoveredServices(
      internals,
      makeState(),
      failRun,
      (source, error, workflowId) => {
        commitErrors.push([source, error, workflowId]);
      },
    );

    expect(stop).toBe(true);
    expect(failRun).toHaveBeenCalled();
    expect(commitErrors).toHaveLength(1);
    expect(commitErrors[0]![0]).toBe('reprovideRecoveredServices');
    expect(commitErrors[0]![2]).toBe('run-1');
  });

  it('proceeds with no resolver configured when the run never expected services', async () => {
    const { internals } = makeInternals({ expectsServices: false });
    const failRun = mock(async () => {});
    const warnings: Event[] = [];
    const stop = await reprovideRecoveredServices(
      internals,
      makeState(),
      failRun,
      noopCommitError,
      (event) => warnings.push(event),
    );
    expect(stop).toBe(false);
    expect(failRun).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(0);
  });

  it('proceeds (false) in worker mode without invoking the resolver', async () => {
    const resolver = mock(() => ({ status: 'available' as const, services: {} }));
    const { internals } = makeInternals({ inline: false, resolver });
    const stop = await reprovideRecoveredServices(
      internals,
      makeState(),
      async () => {},
      noopCommitError,
    );
    expect(stop).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('skips the resolver when the run has no durable "expects services" marker', async () => {
    // A fresh-process recovery of a run that never had services: no marker, so
    // the resolver must not be consulted even if one is configured.
    const resolver = mock(() => ({ status: 'available' as const, services: {} }));
    const { internals } = makeInternals({ resolver, expectsServices: false });
    const failRun = mock(async () => {});
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  it('skips the resolver when services are already live in the map (same process)', async () => {
    const resolver = mock(() => ({ status: 'available' as const, services: {} }));
    const services: ServicesMap = new Map([['run-1', { existing: true }]]);
    const { internals } = makeInternals({ resolver, services });
    const stop = await reprovideRecoveredServices(
      internals,
      makeState(),
      async () => {},
      noopCommitError,
    );
    expect(stop).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(services.get('run-1')).toEqual({ existing: true });
  });

  it('stops (true) and fails the run when the resolver reports unavailable', async () => {
    const { internals, services } = makeInternals({
      resolver: () => ({ status: 'unavailable', reason: 'no config' }),
    });
    const failed: Array<[string, Error]> = [];
    const failRun = async (id: string, error: Error): Promise<void> => {
      failed.push([id, error]);
    };
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(true);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toBe('run-1');
    expect(failed[0]![1].message).toContain('no config');
    expect(services.has('run-1')).toBe(false);
  });

  it('treats a resolver throw as unavailable, using the error message as the reason', async () => {
    const { internals } = makeInternals({
      resolver: () => {
        throw new Error('rebuild rejected');
      },
    });
    const failed: Array<[string, Error]> = [];
    const failRun = async (id: string, error: Error): Promise<void> => {
      failed.push([id, error]);
    };
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(true);
    expect(failed[0]![1].message).toContain('rebuild rejected');
  });

  it('stringifies a non-Error resolver throw', async () => {
    const { internals } = makeInternals({
      resolver: () => {
        throw 'plain string fault';
      },
    });
    const failed: Array<[string, Error]> = [];
    const failRun = async (id: string, error: Error): Promise<void> => {
      failed.push([id, error]);
    };
    await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(failed[0]![1].message).toContain('plain string fault');
  });

  it('still stops (true) and records a fail-warn when the terminal commit itself throws', async () => {
    const { internals } = makeInternals({
      resolver: () => ({ status: 'unavailable', reason: 'no config' }),
    });
    const failRun = mock(async () => {
      throw new Error('storage write failed');
    });
    const commitErrors: Array<[string, unknown, string]> = [];
    const onCommitError = (source: string, error: unknown, workflowId: string): void => {
      commitErrors.push([source, error, workflowId]);
    };

    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, onCommitError);

    // The run is left for a later boot to retry, but we still stop the resume so
    // the generator never advances without services.
    expect(stop).toBe(true);
    expect(commitErrors).toHaveLength(1);
    expect(commitErrors[0]?.[2]).toBe('run-1');
  });
});
