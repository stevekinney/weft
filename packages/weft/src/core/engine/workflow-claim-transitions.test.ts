import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import {
  encodeEpoch,
  encodeWorkflowClaimHolder,
  type WorkflowClaimHolderRecord,
} from './workflow-claim-codec.ts';
import {
  buildWorkflowClaimAcquireTransition,
  buildWorkflowClaimExternalTerminalRotationTransition,
  buildWorkflowClaimReleaseTransition,
  buildWorkflowClaimRenewTransition,
  buildWorkflowClaimTakeoverTransition,
  isWorkflowClaimExpired,
  WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER,
  WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER,
} from './workflow-claim-transitions.ts';

const workflowId = 'wf-1';
const engineId = 'engine-a';

/** Bytes that are not a valid 8-byte epoch — `decodeEpoch` fails closed to `null` on these. */
const corruptEpochBytes = new Uint8Array([1, 2, 3]);

describe('WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER / WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER', () => {
  it('are the ADR-proposed defaults', () => {
    expect(WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER).toBe(3);
    expect(WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER).toBe(2);
  });
});

describe('buildWorkflowClaimAcquireTransition', () => {
  it('mints epoch 1 and conditions on null when the epoch key was never written', () => {
    const fragment = buildWorkflowClaimAcquireTransition({
      workflowId,
      engineId,
      now: 1_000,
      claimTtlMs: 5_000,
      observedEpochBytes: null,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder(workflowId), expectedValue: null },
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: null },
    ]);
    expect(fragment.operations).toEqual([
      { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(1) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder(workflowId),
        value: encodeWorkflowClaimHolder({
          engineId,
          epoch: 1,
          expiresAt: 6_000,
          claimedAt: 1_000,
        }),
      },
    ]);
  });

  it('mints (observedEpoch + 1) for a reused id, never a hardcoded literal epoch', () => {
    // A reused workflow id (e.g. `onTerminalConflict: 'start-new'` after purge)
    // reads its true prior epoch, not 1 — this is the ABA-safety property.
    const priorEpochBytes = encodeEpoch(41);

    const fragment = buildWorkflowClaimAcquireTransition({
      workflowId,
      engineId,
      now: 2_000,
      claimTtlMs: 5_000,
      observedEpochBytes: priorEpochBytes,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder(workflowId), expectedValue: null },
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: priorEpochBytes },
    ]);
    const holderOperation = fragment.operations[1];
    expect(holderOperation).toEqual({
      type: 'put',
      key: KEYS.workflowOwnerHolder(workflowId),
      value: encodeWorkflowClaimHolder({
        engineId,
        epoch: 42,
        expiresAt: 7_000,
        claimedAt: 2_000,
      }),
    });
    expect(fragment.operations[0]).toEqual({
      type: 'put',
      key: KEYS.workflowOwnerEpoch(workflowId),
      value: encodeEpoch(42),
    });
  });

  it('mints epoch 1 when the observed epoch bytes are corrupt (undecodable, not genuinely absent)', () => {
    // Corrupt-but-present bytes still condition byte-for-byte on what was read;
    // only the minted epoch value falls back to the never-written case.
    const fragment = buildWorkflowClaimAcquireTransition({
      workflowId,
      engineId,
      now: 0,
      claimTtlMs: 1_000,
      observedEpochBytes: corruptEpochBytes,
    });

    expect(fragment.conditions[1]).toEqual({
      key: KEYS.workflowOwnerEpoch(workflowId),
      expectedValue: corruptEpochBytes,
    });
    expect(fragment.operations[0]).toEqual({
      type: 'put',
      key: KEYS.workflowOwnerEpoch(workflowId),
      value: encodeEpoch(1),
    });
  });
});

describe('buildWorkflowClaimRenewTransition', () => {
  it('rewrites the holder with the same engineId/epoch/claimedAt and a fresh expiresAt', () => {
    const currentHolder: WorkflowClaimHolderRecord = {
      engineId,
      epoch: 5,
      expiresAt: 1_500,
      claimedAt: 500,
    };
    const currentHolderBytes = encodeWorkflowClaimHolder(currentHolder);

    const fragment = buildWorkflowClaimRenewTransition({
      workflowId,
      now: 2_000,
      claimTtlMs: 3_000,
      currentHolderBytes,
    });

    // The epoch key is not conditioned on separately — only the holder bytes.
    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder(workflowId), expectedValue: currentHolderBytes },
    ]);
    expect(fragment.operations).toEqual([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder(workflowId),
        value: encodeWorkflowClaimHolder({
          engineId,
          epoch: 5,
          expiresAt: 5_000,
          claimedAt: 500,
        }),
      },
    ]);
  });

  it('throws when currentHolderBytes does not decode to a valid holder record', () => {
    expect(() =>
      buildWorkflowClaimRenewTransition({
        workflowId,
        now: 1_000,
        claimTtlMs: 3_000,
        currentHolderBytes: corruptEpochBytes,
      }),
    ).toThrow(/did not decode to a valid holder record/);
  });
});

describe('buildWorkflowClaimReleaseTransition', () => {
  it('conditions on the cached epoch and holder bytes and deletes only the holder', () => {
    const currentEpochBytes = encodeEpoch(9);
    const currentHolderBytes = encodeWorkflowClaimHolder({
      engineId,
      epoch: 9,
      expiresAt: 4_000,
      claimedAt: 1_000,
    });

    const fragment = buildWorkflowClaimReleaseTransition({
      workflowId,
      currentEpochBytes,
      currentHolderBytes,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: currentEpochBytes },
      { key: KEYS.workflowOwnerHolder(workflowId), expectedValue: currentHolderBytes },
    ]);
    expect(fragment.operations).toEqual([
      { type: 'delete', key: KEYS.workflowOwnerHolder(workflowId) },
    ]);
  });
});

describe('buildWorkflowClaimTakeoverTransition', () => {
  it('mints readEpoch + 1 from the epoch bytes read alongside the stale holder, never self-reported', () => {
    const observedEpochBytes = encodeEpoch(12);
    // The stale holder self-reports a DIFFERENT epoch than the epoch key — the
    // takeover must mint from the epoch key's value, never from this field.
    const observedHolderBytes = encodeWorkflowClaimHolder({
      engineId: 'stale-engine',
      epoch: 999,
      expiresAt: 1_000,
      claimedAt: 500,
    });

    const fragment = buildWorkflowClaimTakeoverTransition({
      workflowId,
      engineId,
      now: 3_000,
      claimTtlMs: 6_000,
      observedHolderBytes,
      observedEpochBytes,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder(workflowId), expectedValue: observedHolderBytes },
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: observedEpochBytes },
    ]);
    expect(fragment.operations).toEqual([
      { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(13) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder(workflowId),
        value: encodeWorkflowClaimHolder({
          engineId,
          epoch: 13,
          expiresAt: 9_000,
          claimedAt: 3_000,
        }),
      },
    ]);
  });
});

describe('buildWorkflowClaimExternalTerminalRotationTransition', () => {
  it('rotates the epoch and deletes the holder in one fragment', () => {
    const observedEpochBytes = encodeEpoch(4);

    const fragment = buildWorkflowClaimExternalTerminalRotationTransition({
      workflowId,
      observedEpochBytes,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: observedEpochBytes },
    ]);
    expect(fragment.operations).toEqual([
      { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(5) },
      { type: 'delete', key: KEYS.workflowOwnerHolder(workflowId) },
    ]);
  });

  it('mints epoch 1 when rotating a workflow that was never claimed', () => {
    const fragment = buildWorkflowClaimExternalTerminalRotationTransition({
      workflowId,
      observedEpochBytes: null,
    });

    expect(fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: null },
    ]);
    expect(fragment.operations[0]).toEqual({
      type: 'put',
      key: KEYS.workflowOwnerEpoch(workflowId),
      value: encodeEpoch(1),
    });
  });
});

describe('isWorkflowClaimExpired', () => {
  const expiresAt = 10_000;
  const renewIntervalMs = 1_000;
  // Grace-adjusted deadline = expiresAt + 2 * renewIntervalMs = 12_000.
  const graceAdjustedDeadline =
    expiresAt + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * renewIntervalMs;

  it('is not expired exactly at the grace-adjusted deadline', () => {
    expect(isWorkflowClaimExpired({ expiresAt, now: graceAdjustedDeadline, renewIntervalMs })).toBe(
      false,
    );
  });

  it('is not expired just before the grace-adjusted deadline', () => {
    expect(
      isWorkflowClaimExpired({ expiresAt, now: graceAdjustedDeadline - 1, renewIntervalMs }),
    ).toBe(false);
  });

  it('is expired just after the grace-adjusted deadline', () => {
    expect(
      isWorkflowClaimExpired({ expiresAt, now: graceAdjustedDeadline + 1, renewIntervalMs }),
    ).toBe(true);
  });
});
