import { describe, expect, it } from 'bun:test';

import {
  decodeEpoch,
  decodeOwnershipModeMarker,
  decodeWorkflowClaimHolder,
  encodeEpoch,
  encodeOwnershipModeMarker,
  encodeWorkflowClaimHolder,
  type OwnershipModeMarkerRecord,
  type WorkflowClaimHolderRecord,
} from './workflow-claim-codec.ts';

const textEncoder = new TextEncoder();

/** Encode an arbitrary JSON value as stored bytes, bypassing the typed encoders. */
function storedJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

const holder: WorkflowClaimHolderRecord = {
  engineId: 'engine-a',
  epoch: 7,
  expiresAt: 1_000,
  claimedAt: 900,
};

const marker: OwnershipModeMarkerRecord = {
  mode: 'workflow-lease',
  establishedAt: 1_234,
};

describe('workflow claim epoch codec', () => {
  it('re-exports the lease epoch codec so both fencing tokens share a representation', () => {
    expect(decodeEpoch(encodeEpoch(42))).toBe(42);
    // Byte-identical to the global lease encoding is the point of re-exporting.
    expect(Array.from(encodeEpoch(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
});

describe('decodeWorkflowClaimHolder', () => {
  it('round-trips a well-formed holder record', () => {
    expect(decodeWorkflowClaimHolder(encodeWorkflowClaimHolder(holder))).toEqual(holder);
  });

  it('rejects bytes that are not valid JSON', () => {
    expect(decodeWorkflowClaimHolder(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it('rejects JSON that is not an object', () => {
    expect(decodeWorkflowClaimHolder(storedJson('a string'))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson(null))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson(7))).toBeNull();
  });

  it('rejects a missing or non-string engineId', () => {
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, engineId: undefined }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, engineId: 12 }))).toBeNull();
  });

  it('rejects an empty engineId, which no engine could ever match', () => {
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, engineId: '' }))).toBeNull();
  });

  it('rejects an epoch outside the usable fencing range', () => {
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: 0 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: -1 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: 1.5 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: 'seven' }))).toBeNull();
  });

  it('rejects an epoch at the safe-integer ceiling, which has no representable successor', () => {
    expect(
      decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: Number.MAX_SAFE_INTEGER })),
    ).toBeNull();
    expect(
      decodeWorkflowClaimHolder(storedJson({ ...holder, epoch: Number.MAX_SAFE_INTEGER - 1 })),
    ).toEqual({ ...holder, epoch: Number.MAX_SAFE_INTEGER - 1 });
  });

  it('rejects a finite-but-unusable expiresAt rather than reading it as perpetually live', () => {
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, expiresAt: 1e20 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, expiresAt: -1 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, expiresAt: 1.5 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, expiresAt: '1000' }))).toBeNull();
  });

  it('rejects an unusable claimedAt', () => {
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, claimedAt: -1 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, claimedAt: 1.5 }))).toBeNull();
    expect(decodeWorkflowClaimHolder(storedJson({ ...holder, claimedAt: null }))).toBeNull();
  });

  it('accepts zero timestamps, which are legitimate under an injected test clock', () => {
    expect(
      decodeWorkflowClaimHolder(storedJson({ ...holder, expiresAt: 0, claimedAt: 0 })),
    ).toEqual({ ...holder, expiresAt: 0, claimedAt: 0 });
  });

  it('drops unknown persisted fields instead of preserving them', () => {
    const decoded = decodeWorkflowClaimHolder(storedJson({ ...holder, retiredField: 'x' }));
    expect(decoded).toEqual(holder);
    expect(decoded && 'retiredField' in decoded).toBe(false);
  });
});

describe('decodeOwnershipModeMarker', () => {
  it('round-trips both fencing modes', () => {
    expect(decodeOwnershipModeMarker(encodeOwnershipModeMarker(marker))).toEqual(marker);
    const leaseMarker: OwnershipModeMarkerRecord = { mode: 'lease', establishedAt: 5 };
    expect(decodeOwnershipModeMarker(encodeOwnershipModeMarker(leaseMarker))).toEqual(leaseMarker);
  });

  it('rejects bytes that are not valid JSON', () => {
    expect(decodeOwnershipModeMarker(new Uint8Array([0xff]))).toBeNull();
  });

  it('rejects JSON that is not an object', () => {
    expect(decodeOwnershipModeMarker(storedJson('lease'))).toBeNull();
    expect(decodeOwnershipModeMarker(storedJson(null))).toBeNull();
  });

  it('rejects a mode this build cannot interpret, so the reader fails closed itself', () => {
    expect(decodeOwnershipModeMarker(storedJson({ mode: 'none', establishedAt: 1 }))).toBeNull();
    expect(
      decodeOwnershipModeMarker(storedJson({ mode: 'future-mode', establishedAt: 1 })),
    ).toBeNull();
    expect(decodeOwnershipModeMarker(storedJson({ mode: 7, establishedAt: 1 }))).toBeNull();
    expect(decodeOwnershipModeMarker(storedJson({ establishedAt: 1 }))).toBeNull();
  });

  it('rejects an unusable establishedAt', () => {
    expect(decodeOwnershipModeMarker(storedJson({ mode: 'lease', establishedAt: -1 }))).toBeNull();
    expect(decodeOwnershipModeMarker(storedJson({ mode: 'lease', establishedAt: 1.5 }))).toBeNull();
    expect(decodeOwnershipModeMarker(storedJson({ mode: 'lease' }))).toBeNull();
  });

  it('drops unknown persisted fields instead of preserving them', () => {
    expect(decodeOwnershipModeMarker(storedJson({ ...marker, extra: true }))).toEqual(marker);
  });
});
