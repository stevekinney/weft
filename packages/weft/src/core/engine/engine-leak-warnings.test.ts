import { afterEach, describe, expect, it } from 'bun:test';

import {
  finalizeEngineCleanupIntervalTrackerForTesting,
  setEngineLeakWarningOverrideForTesting,
} from './engine-leak-warnings.ts';

describe('engine leak finalizer', () => {
  afterEach(() => {
    setEngineLeakWarningOverrideForTesting(undefined);
  });

  it('clears the storage size report interval of a collected engine', () => {
    setEngineLeakWarningOverrideForTesting(false);
    const tracker = {
      disposed: true,
      cleanupInterval: null,
      secondInstanceDetectionInterval: null,
      storageSizeReportInterval: setInterval(() => {}, 1_000),
      testToken: undefined,
    };

    finalizeEngineCleanupIntervalTrackerForTesting(tracker);

    expect(tracker.storageSizeReportInterval).toBeNull();
  });
});
