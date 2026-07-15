/**
 * Test-only state and helpers for the engine cleanup-interval finalizer
 * leak-warning system. Kept in a sibling module so `index.ts` does not
 * accumulate test-only ceremony.
 */

export type EngineCleanupIntervalDisposalTracker = {
  disposed: boolean;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  /**
   * The optional second-instance detector interval, tracked alongside the
   * cleanup interval so the same finalizer clears it when an engine is
   * garbage-collected without `[Symbol.dispose]()`. Null when detection is off.
   */
  secondInstanceDetectionInterval: ReturnType<typeof setInterval> | null;
  testToken: symbol | undefined;
};

let engineLeakWarningOverrideForTesting: boolean | undefined;
let engineLeakCollectionCountForTesting = 0;
let nextEngineLeakWarningTokenForTesting: symbol | undefined;
const engineLeakWarningTokensForTesting = new Set<symbol>();

function finalizeEngineCleanupIntervalTracker(tracker: EngineCleanupIntervalDisposalTracker): void {
  engineLeakCollectionCountForTesting++;

  if (tracker.cleanupInterval !== null) {
    clearInterval(tracker.cleanupInterval);
    tracker.cleanupInterval = null;
  }

  if (tracker.secondInstanceDetectionInterval !== null) {
    clearInterval(tracker.secondInstanceDetectionInterval);
    tracker.secondInstanceDetectionInterval = null;
  }

  if (!tracker.disposed && shouldEmitEngineLeakWarning()) {
    if (tracker.testToken !== undefined) {
      engineLeakWarningTokensForTesting.add(tracker.testToken);
    }

    process.emitWarning(
      'WeftEngineLeakWarning: A Weft Engine was garbage-collected without calling [Symbol.dispose](). Use `using`, `await using`, or call engine[Symbol.dispose]() to clear background timers and release runtime resources.',
    );
  }
}

export const engineCleanupIntervalFinalizer =
  new FinalizationRegistry<EngineCleanupIntervalDisposalTracker>((tracker) => {
    finalizeEngineCleanupIntervalTracker(tracker);
  });

/** Test-only hook for the finalizer callback's synchronous warning gate. */
export function finalizeEngineCleanupIntervalTrackerForTesting(
  tracker: EngineCleanupIntervalDisposalTracker,
): void {
  finalizeEngineCleanupIntervalTracker(tracker);
}

export function shouldEmitEngineLeakWarning(): boolean {
  if (engineLeakWarningOverrideForTesting !== undefined) {
    return engineLeakWarningOverrideForTesting;
  }

  return Bun.env['WEFT_DEV_WARNINGS'] === '1' || Bun.env['NODE_ENV'] === 'development';
}

/** Test-only override for the engine leak-warning environment gate. */
export function setEngineLeakWarningOverrideForTesting(value: boolean | undefined): void {
  engineLeakWarningOverrideForTesting = value;
}

/** Test-only marker applied to the next constructed engine leak tracker. */
export function setNextEngineLeakWarningTokenForTesting(value: symbol | undefined): void {
  nextEngineLeakWarningTokenForTesting = value;
}

/** Read the test-only next-token marker, consuming it. */
export function consumeNextEngineLeakWarningTokenForTesting(): symbol | undefined {
  const token = nextEngineLeakWarningTokenForTesting;
  nextEngineLeakWarningTokenForTesting = undefined;
  return token;
}

/** Test-only count of engine cleanup finalizer observations. */
export function getEngineLeakCollectionCountForTesting(): number {
  return engineLeakCollectionCountForTesting;
}

/** Test-only visibility into whether a tagged engine leak emitted a warning. */
export function hasEngineLeakWarningTokenForTesting(token: symbol): boolean {
  return engineLeakWarningTokensForTesting.has(token);
}

/** Test-only cleanup for tagged leak warning observations. */
export function clearEngineLeakWarningTokenForTesting(token: symbol): void {
  engineLeakWarningTokensForTesting.delete(token);
}

/** Test-only visibility into the engine leak-warning environment gate. */
export function shouldEmitEngineLeakWarningForTesting(): boolean {
  return shouldEmitEngineLeakWarning();
}
