/**
 * Memory profiler for detecting unbounded growth under sustained load.
 *
 * Samples process memory (RSS, heap) at configurable intervals and applies
 * linear regression to determine whether RSS is growing over time. A stable
 * system shows a near-zero slope after the initial warmup period.
 *
 * @module diagnostics/memory-profiler
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single point-in-time memory measurement. */
export interface MemorySample {
  timestamp: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

/** Summary of a profiling session. */
export interface MemoryProfile {
  samples: MemorySample[];
  durationMilliseconds: number;
  peakRss: number;
  averageRss: number;
}

/** Result of a stability analysis. */
export interface StabilityResult {
  /** Whether RSS growth rate is within the acceptable threshold. */
  stable: boolean;
  /** Estimated RSS growth in bytes per second (from linear regression). */
  rssGrowthRatePerSecond: number;
  /** The threshold used for comparison (bytes/sec). */
  thresholdPerSecond: number;
  /** Number of samples analyzed (after warmup skip). */
  samplesAnalyzed: number;
}

/**
 * Options for stability analysis.
 *
 * @example
 * ```ts
 * import { analyzeStability, type StabilityOptions } from '@lostgradient/weft';
 *
 * const options: StabilityOptions = {
 *   maxGrowthRatePerSecond: 5 * 1024, // 5 KB/s threshold
 *   warmupSamples: 3,
 * };
 * const result = analyzeStability([], options);
 * console.log(result.stable); // true (no samples)
 * ```
 */
export interface StabilityOptions {
  /**
   * Maximum acceptable RSS growth rate in bytes per second.
   * Default: 10 KB/sec — accounts for minor GC jitter and allocator noise.
   */
  maxGrowthRatePerSecond?: number;
  /**
   * Number of initial samples to skip (warmup period where the runtime
   * JIT-compiles, allocates caches, etc.). Default: 5.
   */
  warmupSamples?: number;
}

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

/**
 * Simple least-squares linear regression over (x, y) points.
 * Returns the slope and intercept of the best-fit line y = slope * x + intercept.
 *
 * @example
 * ```ts
 * import { linearRegression } from '@lostgradient/weft';
 *
 * const points: [number, number][] = [
 *   [0, 100], [1, 105], [2, 110], [3, 115],
 * ];
 * const { slope, intercept } = linearRegression(points);
 * console.log(slope);     // ~5
 * console.log(intercept); // ~100
 * ```
 */
export function linearRegression(points: [number, number][]): {
  slope: number;
  intercept: number;
} {
  const n = points.length;
  if (n <= 1) {
    return { slope: 0, intercept: n === 1 ? points[0]![1] : 0 };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) {
    return { slope: 0, intercept: sumY / n };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

// ---------------------------------------------------------------------------
// Stability analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a series of memory samples to determine if RSS is stable.
 *
 * Applies linear regression to RSS values over time (in seconds) after
 * skipping a configurable warmup period. The system is considered stable
 * if the growth rate is below the configured threshold.
 *
 * @example
 * ```ts
 * import { MemoryProfiler, analyzeStability } from '@lostgradient/weft';
 *
 * const profiler = new MemoryProfiler();
 * profiler.start(100);
 * await new Promise((r) => setTimeout(r, 600));
 * profiler.stop();
 * const { samples } = profiler.profile();
 * const stability = analyzeStability(samples, { warmupSamples: 2 });
 * console.log(stability.stable);
 * ```
 */
export function analyzeStability(
  samples: MemorySample[],
  options: StabilityOptions = {},
): StabilityResult {
  const { maxGrowthRatePerSecond = 10 * 1024, warmupSamples = 5 } = options;

  const analyzed = samples.slice(warmupSamples);

  if (analyzed.length <= 1) {
    return {
      stable: true,
      rssGrowthRatePerSecond: 0,
      thresholdPerSecond: maxGrowthRatePerSecond,
      samplesAnalyzed: analyzed.length,
    };
  }

  // Normalize timestamps to seconds from the first analyzed sample
  const baseTime = analyzed[0]!.timestamp;
  const points: [number, number][] = [];
  for (const sample of analyzed) {
    points.push([(sample.timestamp - baseTime) / 1000, sample.rss]);
  }

  const { slope } = linearRegression(points);

  return {
    stable: Math.abs(slope) <= maxGrowthRatePerSecond,
    rssGrowthRatePerSecond: slope,
    thresholdPerSecond: maxGrowthRatePerSecond,
    samplesAnalyzed: analyzed.length,
  };
}

// ---------------------------------------------------------------------------
// MemoryProfiler
// ---------------------------------------------------------------------------

/**
 * Interval-based memory profiler. Call {@link start} to begin sampling and
 * {@link stop} when the workload is done. Use {@link profile} to retrieve
 * the collected samples and summary statistics.
 *
 * @example
 * ```ts
 * import { MemoryProfiler } from '@lostgradient/weft';
 *
 * const profiler = new MemoryProfiler();
 * profiler.start(200); // sample every 200ms
 * await new Promise((r) => setTimeout(r, 1000));
 * profiler.stop();
 * const { peakRss, averageRss, samples } = profiler.profile();
 * console.log('Peak RSS:', peakRss);
 * console.log('Samples:', samples.length);
 * ```
 */
export class MemoryProfiler {
  #samples: MemorySample[];
  #timer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.#samples = [];
    this.#timer = null;
  }

  #recordSnapshot(): void {
    this.#samples.push(this.snapshot());
  }

  /** Take a single snapshot of current process memory. */
  snapshot(): MemorySample {
    const usage = process.memoryUsage();
    return {
      timestamp: Date.now(),
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    };
  }

  /** Begin sampling memory at the given interval (milliseconds). */
  start(intervalMilliseconds: number): void {
    this.stop();
    this.#recordSnapshot();
    this.#timer = setInterval(this.#recordSnapshot.bind(this), intervalMilliseconds);
  }

  /** Stop interval sampling. Idempotent. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Clear all collected samples. */
  reset(): void {
    this.stop();
    this.#samples = [];
  }

  /** Return the collected profile with summary statistics. */
  profile(): MemoryProfile {
    const samples = this.#samples;
    if (samples.length === 0) {
      return { samples: [], durationMilliseconds: 0, peakRss: 0, averageRss: 0 };
    }

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;

    let peakRss = 0;
    let totalRss = 0;
    for (const sample of samples) {
      if (sample.rss > peakRss) peakRss = sample.rss;
      totalRss += sample.rss;
    }

    return {
      samples,
      durationMilliseconds: last.timestamp - first.timestamp,
      peakRss,
      averageRss: totalRss / samples.length,
    };
  }
}
