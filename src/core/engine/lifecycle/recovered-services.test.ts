/**
 * Unit tests for the shared `reprovideRecoveredServices` helper — the recovery
 * seam used by BOTH the running-workflow resume path and the delayed-start timer
 * path. Tested directly (rather than only end-to-end) because the delayed-start
 * execution path is timer-bound and not deterministically drivable in-process,
 * and because the error/commit-fault branches need fault injection.
 */

import { describe, expect, it, mock } from 'bun:test';

import type { WorkflowState } from '../../types.ts';
import { reprovideRecoveredServices } from './recovered-services.ts';

type ServicesMap = Map<string, unknown>;

function makeState(id = 'run-1', type = 'wf'): WorkflowState {
  return {
    id,
    type,
    status: 'running',
    input: { tenant: 'acme' },
    version: '1',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Minimal internals stub: an inline engine with a services map + resolver. */
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
}): { internals: never; services: ServicesMap } {
  const services: ServicesMap = options.services ?? new Map();
  const internals = {
    inlineStrategy: options.inline === false ? null : {},
    workflowServices: services,
    options: { resolveWorkflowServices: options.resolver },
  } as never;
  return { internals, services };
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
    const failRun = mock(async () => {});
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(true);
    expect(failRun).toHaveBeenCalledWith('run-1', 'no config');
    expect(services.has('run-1')).toBe(false);
  });

  it('treats a resolver throw as unavailable, using the error message as the reason', async () => {
    const { internals } = makeInternals({
      resolver: () => {
        throw new Error('rebuild rejected');
      },
    });
    const failRun = mock(async () => {});
    const stop = await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(stop).toBe(true);
    expect(failRun).toHaveBeenCalledWith('run-1', 'rebuild rejected');
  });

  it('stringifies a non-Error resolver throw', async () => {
    const { internals } = makeInternals({
      resolver: () => {
        throw 'plain string fault';
      },
    });
    const failRun = mock(async () => {});
    await reprovideRecoveredServices(internals, makeState(), failRun, noopCommitError);
    expect(failRun).toHaveBeenCalledWith('run-1', 'plain string fault');
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
