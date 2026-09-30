import type { BatchOperation } from './interface.ts';

import {
  isConstrainedCodexRunner,
  isGitHubActionsRunner,
} from '../../scripts/benchmarks/benchmark-environment.ts';
import { readEnvironmentVariable } from '../runtime/environment-configuration.ts';
import type { BunSQLiteStorage } from './bun-sql.ts';

/** Generate a realistic ~2KB value (typical checkpoint size). */
export function generateCheckpointValue(): Uint8Array {
  const value = new Uint8Array(2048);
  crypto.getRandomValues(value);
  return value;
}

/**
 * The opt-in throughput target. Normal validation checks data integrity; set
 * WEFT_SQLITE_ARCHITECTURE_BENCHMARK=1 to enforce the median throughput gate on an isolated
 * machine, through `scripts/benchmarks/bun-sql.test.ts`.
 */
export const TARGET_WRITES_PER_SECOND =
  isConstrainedCodexRunner() || isGitHubActionsRunner() ? 5_000 : 20_000;
export const runArchitectureBenchmark =
  readEnvironmentVariable('WEFT_SQLITE_ARCHITECTURE_BENCHMARK') === '1';

export type SQLiteBenchmarkWorkload = {
  batchWriteBatchSize: number;
  batchWriteSampleSize: number;
  batchWriteTotal: number;
  individualPutTotal: number;
  mixedOperationBatchSize: number;
  mixedOperationTotal: number;
};

export const INTEGRITY_WORKLOAD: SQLiteBenchmarkWorkload = {
  batchWriteBatchSize: 20,
  batchWriteSampleSize: 1,
  batchWriteTotal: 100,
  individualPutTotal: 100,
  mixedOperationBatchSize: 20,
  mixedOperationTotal: 100,
};

export const ARCHITECTURE_BENCHMARK_WORKLOAD: SQLiteBenchmarkWorkload = {
  batchWriteBatchSize: 500,
  batchWriteSampleSize: 3,
  batchWriteTotal: 25_000,
  individualPutTotal: 10_000,
  mixedOperationBatchSize: 1_000,
  mixedOperationTotal: 50_000,
};

export function selectSQLiteBenchmarkWorkload(
  architectureBenchmark: boolean,
): SQLiteBenchmarkWorkload {
  return architectureBenchmark ? ARCHITECTURE_BENCHMARK_WORKLOAD : INTEGRITY_WORKLOAD;
}

export const benchmarkWorkload = selectSQLiteBenchmarkWorkload(runArchitectureBenchmark);

export function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Run the selected batch-write workload and return its measured throughput. A
 * 100-write warmup (excluded from timing) primes WAL mode and prepared
 * statements; every sample's batches are pre-generated before any timing
 * starts; `performance.now()` brackets only the `storage.batch` calls; and
 * each batch object is consumed exactly once.
 */
export async function runBatchWriteBenchmark(
  storage: BunSQLiteStorage,
  value: Uint8Array,
  batchWriteWorkload: Pick<
    SQLiteBenchmarkWorkload,
    'batchWriteBatchSize' | 'batchWriteSampleSize' | 'batchWriteTotal'
  >,
): Promise<{ medianWritesPerSecond: number; writesPerSecondSamples: number[] }> {
  // Warm up: small batch to trigger WAL mode and prime prepared statements.
  await storage.batch(
    Array.from({ length: 100 }, (_, index) => ({
      type: 'put' as const,
      key: `warmup:${index}`,
      value,
    })),
  );

  const {
    batchWriteBatchSize: batchSize,
    batchWriteSampleSize,
    batchWriteTotal: totalWrites,
  } = batchWriteWorkload;
  const batches = totalWrites / batchSize;

  // Pre-generate each sample's batch operations so timing reflects storage
  // throughput rather than key generation or object allocation.
  const sampleBatches: BatchOperation[][][] = Array.from(
    { length: batchWriteSampleSize },
    (_sample, sampleIndex) =>
      Array.from({ length: batches }, (_batch, batchIndex) =>
        Array.from({ length: batchSize }, (_item, itemIndex) => ({
          type: 'put' as const,
          key: `wf:${sampleIndex}:${String(batchIndex * batchSize + itemIndex).padStart(10, '0')}:ckpt`,
          value,
        })),
      ),
  );

  const writesPerSecondSamples: number[] = [];
  for (const batchesForSample of sampleBatches) {
    const start = performance.now();
    for (const batch of batchesForSample) {
      await storage.batch(batch);
    }
    const elapsed = performance.now() - start;
    writesPerSecondSamples.push((totalWrites / elapsed) * 1000);
  }

  return {
    medianWritesPerSecond: Math.round(median(writesPerSecondSamples)),
    writesPerSecondSamples,
  };
}
