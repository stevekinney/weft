import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { CleanupWarningEvent } from '../events.ts';
import {
  createCleanupIntervalTick,
  createSecondInstanceDetectorResolver,
} from './engine-runtime-helpers.ts';
import { getInternals } from './internals.ts';

describe('engine runtime helpers', () => {
  it('clears the cleanup interval when the engine has been collected', () => {
    const cleanupInterval = setInterval(() => {}, 1_000);
    const tracker = {
      disposed: false,
      cleanupInterval,
      secondInstanceDetectionInterval: null,
      testToken: undefined,
    };

    const tick = createCleanupIntervalTick(
      { deref: () => undefined } as WeakRef<Engine<object, object>>,
      tracker,
    );
    tick();

    expect(tracker.cleanupInterval).toBeNull();
  });

  it('routes cleanup tick failures through the engine cleanup warning path', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const tracker = {
      disposed: false,
      cleanupInterval: null,
      secondInstanceDetectionInterval: null,
      testToken: undefined,
    };
    const cleanupExpiredResponses = mock(async () => {
      throw new Error('cleanup exploded');
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event);
    });
    getInternals(engine).updateCoordinator.cleanupExpiredResponses = cleanupExpiredResponses;

    const tick = createCleanupIntervalTick(new WeakRef(engine), tracker);
    tick();

    await sleepForTesting(0);

    expect(cleanupExpiredResponses).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe('cleanupExpiredResponses');
    expect(warnings[0]!.error.message).toBe('cleanup exploded');
    expect(tracker.cleanupInterval).toBeNull();
  });

  describe('createSecondInstanceDetectorResolver', () => {
    it('returns null when the engine has been garbage-collected', () => {
      const resolve = createSecondInstanceDetectorResolver({ deref: () => undefined } as WeakRef<
        Engine<object, object>
      >);
      expect(resolve()).toBeNull();
    });

    it('returns null when the engine is disposed', () => {
      const engine = new Engine({ storage: new MemoryStorage(), detectSecondInstance: true });
      const resolve = createSecondInstanceDetectorResolver(new WeakRef(engine));
      // Live before disposal: the detector is present.
      expect(resolve()).not.toBeNull();
      engine[Symbol.dispose]();
      // After disposal the resolver reports gone, so the interval tick skips.
      expect(resolve()).toBeNull();
    });

    it('returns the live detector for an enabled, undisposed engine', () => {
      using engine = new Engine({ storage: new MemoryStorage(), detectSecondInstance: true });
      const resolve = createSecondInstanceDetectorResolver(new WeakRef(engine));
      expect(resolve()).toBe(getInternals(engine).secondInstanceDetector);
    });
  });
});
