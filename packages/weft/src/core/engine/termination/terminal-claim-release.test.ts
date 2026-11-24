import { describe, expect, it } from 'bun:test';

import type { EngineInternals } from '../internals.ts';
import {
  captureCurrentClaimEpoch,
  releaseWorkflowClaimAfterTerminalSettlement,
} from './terminal-claim-release.ts';

function internalsHolding(
  currentEpoch: number | null,
  release: (workflowId: string, expectedEpoch: number) => Promise<unknown>,
): EngineInternals {
  return { workflowClaimRegistry: { currentEpoch: () => currentEpoch, release } } as never;
}

describe('releaseWorkflowClaimAfterTerminalSettlement', () => {
  it('releases the claim at the epoch captured when the terminal write committed', async () => {
    const released: Array<[string, number]> = [];
    const internals = internalsHolding(3, async (workflowId, epoch) => {
      released.push([workflowId, epoch]);
    });

    await releaseWorkflowClaimAfterTerminalSettlement(internals, 'finished-run', 3);

    expect(released).toEqual([['finished-run', 3]]);
  });

  it('leaves a replacement run claim alone when the epoch is no longer the captured one', async () => {
    const released: Array<[string, number]> = [];
    const internals = internalsHolding(4, async (workflowId, epoch) => {
      released.push([workflowId, epoch]);
    });

    await releaseWorkflowClaimAfterTerminalSettlement(internals, 'finished-run', 3);

    expect(released).toEqual([]);
  });

  it('does nothing without a claim registry or a captured epoch', async () => {
    await releaseWorkflowClaimAfterTerminalSettlement(
      { workflowClaimRegistry: null } as never,
      'finished-run',
      3,
    );
    await releaseWorkflowClaimAfterTerminalSettlement(
      internalsHolding(3, async () => {
        throw new Error('unreachable');
      }),
      'finished-run',
      null,
    );
  });

  it('settles quietly when the release throws, leaving the claim to expire', async () => {
    const internals = internalsHolding(3, async () => {
      throw new Error('release failed');
    });

    await releaseWorkflowClaimAfterTerminalSettlement(internals, 'finished-run', 3);
  });
});

describe('captureCurrentClaimEpoch', () => {
  it('reads the registry epoch, or null without a registry', () => {
    expect(
      captureCurrentClaimEpoch(
        internalsHolding(7, async () => {}),
        'run',
      ),
    ).toBe(7);
    expect(captureCurrentClaimEpoch({ workflowClaimRegistry: null } as never, 'run')).toBeNull();
  });
});
