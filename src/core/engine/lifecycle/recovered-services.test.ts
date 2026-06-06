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
import type { WorkflowState } from '../../types.ts';
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

/**
 * Minimal internals stub: an inline engine with a services map, resolver, and a
 * real {@link MemoryStorage} so the helper's durable "expects services" marker
 * read works. `expectsServices` controls whether the marker is pre-populated —
 * defaults to `true` so resolver-firing branches reach the resolver. Set it to
 * `false` to exercise the no-marker short-circuit.
 */
function makeInternals(options: {
  inline?: boolean;
  resolver?: (info: {
    workflowId: string;
    workflowType: string;
    input: unknown;
  }) =>
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

  it('proceeds (false) with no resolver configured', async () => {
    const { internals } = makeInternals({});
    const failRun = mock(async () => {});
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(false);
    expect(failRun).not.toHaveBeenCalled();
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
