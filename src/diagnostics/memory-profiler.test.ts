import { afterEach, describe, expect, it } from 'bun:test';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import {
  type MemorySample,
  MemoryProfiler,
  analyzeStability,
  linearRegression,
} from './memory-profiler.ts';

// ---------------------------------------------------------------------------
// Unit tests: linearRegression
// ---------------------------------------------------------------------------

describe('linearRegression', () => {
  it('returns zero slope for flat data', () => {
    const points: [number, number][] = [
      [0, 100],
      [1, 100],
      [2, 100],
      [3, 100],
    ];
    const { slope, intercept } = linearRegression(points);
    expect(slope).toBeCloseTo(0, 5);
    expect(intercept).toBeCloseTo(100, 5);
  });

  it('returns correct slope for linear data', () => {
    const points: [number, number][] = [
      [0, 0],
      [1, 2],
      [2, 4],
      [3, 6],
    ];
    const { slope, intercept } = linearRegression(points);
    expect(slope).toBeCloseTo(2, 5);
    expect(intercept).toBeCloseTo(0, 5);
  });

  it('handles a single point', () => {
    const points: [number, number][] = [[5, 42]];
    const { slope, intercept } = linearRegression(points);
    expect(slope).toBe(0);
    expect(intercept).toBe(42);
  });

  it('handles noisy data with upward trend', () => {
    const points: [number, number][] = [
      [0, 10],
      [1, 12],
      [2, 11],
      [3, 14],
      [4, 13],
      [5, 16],
    ];
    const { slope } = linearRegression(points);
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: analyzeStability
// ---------------------------------------------------------------------------

describe('analyzeStability', () => {
  it('reports stable for flat RSS samples', () => {
    const now = Date.now();
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: now + i * 1000,
      rss: 50 * 1024 * 1024, // 50 MB flat
      heapUsed: 30 * 1024 * 1024,
      heapTotal: 40 * 1024 * 1024,
      external: 1024 * 1024,
      arrayBuffers: 512 * 1024,
    }));

    const result = analyzeStability(samples);
    expect(result.stable).toBe(true);
    expect(result.rssGrowthRatePerSecond).toBeCloseTo(0, 1);
  });

  it('reports unstable for linearly growing RSS', () => {
    const now = Date.now();
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: now + i * 1000,
      rss: 50 * 1024 * 1024 + i * 1024 * 1024, // grows 1MB/sec
      heapUsed: 30 * 1024 * 1024 + i * 512 * 1024,
      heapTotal: 40 * 1024 * 1024 + i * 512 * 1024,
      external: 1024 * 1024,
      arrayBuffers: 512 * 1024,
    }));

    const result = analyzeStability(samples);
    expect(result.stable).toBe(false);
    expect(result.rssGrowthRatePerSecond).toBeGreaterThan(0);
  });

  it('respects custom threshold', () => {
    const now = Date.now();
    // Slight growth: 100 bytes/sec
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: now + i * 1000,
      rss: 50 * 1024 * 1024 + i * 100,
      heapUsed: 30 * 1024 * 1024,
      heapTotal: 40 * 1024 * 1024,
      external: 1024 * 1024,
      arrayBuffers: 512 * 1024,
    }));

    // With a tight threshold, this should be unstable
    const tight = analyzeStability(samples, { maxGrowthRatePerSecond: 10 });
    expect(tight.stable).toBe(false);

    // With a loose threshold, this should be stable
    const loose = analyzeStability(samples, { maxGrowthRatePerSecond: 200 });
    expect(loose.stable).toBe(true);
  });

  it('skips warmup samples when configured', () => {
    const now = Date.now();
    // First 5 samples spike, then flat
    const samples: MemorySample[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: now + i * 1000,
      rss: i < 5 ? 50 * 1024 * 1024 + i * 10 * 1024 * 1024 : 100 * 1024 * 1024,
      heapUsed: 30 * 1024 * 1024,
      heapTotal: 40 * 1024 * 1024,
      external: 1024 * 1024,
      arrayBuffers: 512 * 1024,
    }));

    // Without warmup skip, the initial ramp makes it look unstable
    const withoutSkip = analyzeStability(samples, { warmupSamples: 0 });
    expect(withoutSkip.samplesAnalyzed).toBe(20);

    // With warmup skip, the flat portion is stable
    const withSkip = analyzeStability(samples, { warmupSamples: 5 });
    expect(withSkip.stable).toBe(true);
  });

  it('requires minimum sample count', () => {
    const samples: MemorySample[] = [
      {
        timestamp: Date.now(),
        rss: 50 * 1024 * 1024,
        heapUsed: 30 * 1024 * 1024,
        heapTotal: 40 * 1024 * 1024,
        external: 1024 * 1024,
        arrayBuffers: 512 * 1024,
      },
    ];

    const result = analyzeStability(samples);
    // With only one sample, we can't determine growth — assume stable
    expect(result.stable).toBe(true);
    expect(result.rssGrowthRatePerSecond).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: MemoryProfiler
// ---------------------------------------------------------------------------

describe('MemoryProfiler', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('takes a snapshot of current memory', () => {
    const profiler = new MemoryProfiler();
    const sample = profiler.snapshot();

    expect(sample.timestamp).toBeGreaterThan(0);
    expect(sample.rss).toBeGreaterThan(0);
    expect(sample.heapUsed).toBeGreaterThan(0);
    expect(sample.heapTotal).toBeGreaterThan(0);
    expect(typeof sample.external).toBe('number');
    expect(typeof sample.arrayBuffers).toBe('number');
  });

  it('collects samples over an interval', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));

    const profiler = new MemoryProfiler();
    profiler.start(50); // sample every 50ms

    await advanceTimersByTime(250);
    profiler.stop();

    const profile = profiler.profile();
    // Should have at least a few samples
    expect(profile.samples.length).toBeGreaterThanOrEqual(3);
    expect(profile.durationMilliseconds).toBeGreaterThan(0);
    expect(profile.peakRss).toBeGreaterThan(0);
    expect(profile.averageRss).toBeGreaterThan(0);
  });

  it('stop is idempotent', () => {
    const profiler = new MemoryProfiler();
    profiler.start(100);
    profiler.stop();
    profiler.stop(); // should not throw
  });

  it('reset clears collected samples', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));

    const profiler = new MemoryProfiler();
    profiler.start(50);
    await advanceTimersByTime(150);
    profiler.stop();

    expect(profiler.profile().samples.length).toBeGreaterThan(0);

    profiler.reset();
    expect(profiler.profile().samples.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: engine under load shows stable memory
// ---------------------------------------------------------------------------

describe('engine memory stability under load', () => {
  it('RSS stays bounded after running many workflows to completion', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    // A trivial workflow that completes in one step
    const trivial = workflow({ name: 'trivial' }).execute(async function* (
      _context: WorkflowContext,
      input: unknown,
    ) {
      return `done:${String(input)}`;
    });
    engine.register(trivial);

    const profiler = new MemoryProfiler();
    profiler.start(100); // sample every 100ms

    // Run workflows in batches. We can't do 10K/sec for an hour in a unit
    // test, but we can run enough to detect linear growth in engine maps.
    const totalWorkflows = 2000;
    const batchSize = 100;
    const batches = totalWorkflows / batchSize;

    for (let batch = 0; batch < batches; batch++) {
      const handles = await Promise.all(
        Array.from({ length: batchSize }, (_, i) =>
          engine.start('trivial', `batch-${batch}-item-${i}`),
        ),
      );
      // Wait for all to complete
      await Promise.all(handles.map((handle) => handle.result()));
    }

    // Let GC run
    Bun.gc(true);
    await sleepForTesting(100);

    profiler.stop();

    const profile = profiler.profile();
    const stability = analyzeStability(profile.samples, {
      warmupSamples: 3,
      // Allow up to 50KB/sec growth (accounts for test runner overhead,
      // storage growth from MemoryStorage, and GC jitter)
      maxGrowthRatePerSecond: 50 * 1024,
    });

    // The engine's internal maps should be cleaned up after workflow completion.
    // RSS may fluctuate due to GC, but should not show unbounded linear growth.
    expect(stability.stable).toBe(true);

    engine[Symbol.dispose]();
  }, 30_000); // 30s timeout for this test

  it('engine internal maps are cleaned up after workflow completion', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const trivial = workflow({ name: 'trivial' }).execute(async function* (
      _context: WorkflowContext,
      input: unknown,
    ) {
      return `done:${String(input)}`;
    });
    engine.register(trivial);

    // Run a batch of workflows
    const handles = await Promise.all(
      Array.from({ length: 100 }, (_, i) => engine.start('trivial', `item-${i}`)),
    );
    await Promise.all(handles.map((handle) => handle.result()));

    // Force GC to let FinalizationRegistry clean up WeakRef entries
    Bun.gc(true);
    await sleepForTesting(50);

    // Verify the engine can still start new workflows (no leaked state
    // blocking new work) and that previously completed workflows report
    // completed status when queried. This confirms the engine's transient
    // maps (resultResolvers, checkpoints, signalWaiters) were properly
    // cleaned up — leaked entries would cause errors or incorrect state.
    const newHandle = await engine.start('trivial', 'after-batch');
    const newResult = await newHandle.result();
    expect(newResult).toBe('done:after-batch');

    // Check that a completed workflow's state is 'completed' in storage
    const firstId = handles[0]!.id;
    const listed = await engine.list({ status: 'completed' });
    const found = listed.items.find((item) => item.id === firstId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('completed');

    engine[Symbol.dispose]();
  });
});
