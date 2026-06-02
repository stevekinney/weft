import { describe, expect, it } from 'bun:test';

import {
  coreStorageCapabilities,
  fullStorageCapabilities,
} from './storage-adapter.test-support.ts';

describe('storage adapter test support', () => {
  it('exposes full and core capability fixtures', () => {
    expect(fullStorageCapabilities()).toEqual({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    });

    expect(coreStorageCapabilities()).toEqual({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });
  });
});
