import { describe, expect, it } from 'bun:test';

import {
  coreStorageCapabilities,
  fullStorageCapabilities,
} from './storage-adapter.test-support.ts';

describe('storage adapter test-support capability rows', () => {
  it('returns the fully featured single-process capability profile', () => {
    expect(fullStorageCapabilities()).toEqual({
      persistence: 'ephemeral',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    });
  });

  it('returns the core adapter capability profile without optional guarantees', () => {
    expect(coreStorageCapabilities()).toEqual({
      persistence: 'ephemeral',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });
  });
});
