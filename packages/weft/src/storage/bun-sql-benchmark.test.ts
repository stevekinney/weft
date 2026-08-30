import { afterEach, describe, expect, it } from 'bun:test';

import type { BatchOperation } from './interface';

import {
  isConstrainedCodexRunner,
  isGitHubActionsRunner,
} from '../benchmarks/benchmark-environment';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../testing/storage-backends.test-support.ts';
import { BunSQLiteStorage } from './bun-sql';

/** Generate a realistic ~2KB value (typical checkpoint size). */
function generateCheckpointValue(): Uint8Array {
  const value = new Uint8Array(2048);
  crypto.getRandomValues(value);
  return value;
}

/**
 * The opt-in throughput target. Normal validation records benchmark output and
 * checks data integrity; set WEFT_SQLITE_ARCHITECTURE_BENCHMARK=1 to enforce
 * the median throughput gate on an isolated machine.
 */
const TARGET_WRITES_PER_SECOND =
  isConstrainedCodexRunner() || isGitHubActionsRunner() ? 5_000 : 20_000;
const runArchitectureBenchmark = process.env['WEFT_SQLITE_ARCHITECTURE_BENCHMARK'] === '1';

type SQLiteBenchmarkWorkload = {
  batchWriteBatchSize: number;
  batchWriteSampleSize: number;
  batchWriteTotal: number;
  individualPutTotal: number;
  mixedOperationBatchSize: number;
  mixedOperationTotal: number;
};

const INTEGRITY_WORKLOAD: SQLiteBenchmarkWorkload = {
  batchWriteBatchSize: 20,
  batchWriteSampleSize: 1,
  batchWriteTotal: 100,
  individualPutTotal: 100,
  mixedOperationBatchSize: 20,
  mixedOperationTotal: 100,
};

const ARCHITECTURE_BENCHMARK_WORKLOAD: SQLiteBenchmarkWorkload = {
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

const integrityWorkload = selectSQLiteBenchmarkWorkload(false);
const benchmarkWorkload = selectSQLiteBenchmarkWorkload(runArchitectureBenchmark);
const runSQLiteArchitectureBenchmark = runArchitectureBenchmark ? it : it.skip;

function median(values: number[]): number {
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
async function runBatchWriteBenchmark(
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

describe('BunSQLiteStorage benchmark', () => {
  const fixtureCleanups: Array<() => void> = [];

  function createStorage(): BunSQLiteStorage {
    const fixture = createDiskBackedTestFixture({
      prefix: 'sqlite-bench',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    fixtureCleanups.push(fixture.cleanup);
    return new BunSQLiteStorage(fixture.path);
  }

  afterEach(() => {
    for (const cleanup of fixtureCleanups) {
      cleanup();
    }
    fixtureCleanups.length = 0;
  });

  it('selects integrity workloads by default and full workloads only when opted in', () => {
    expect(selectSQLiteBenchmarkWorkload(false)).toEqual(INTEGRITY_WORKLOAD);
    expect(selectSQLiteBenchmarkWorkload(true)).toEqual(ARCHITECTURE_BENCHMARK_WORKLOAD);
    expect(selectSQLiteBenchmarkWorkload(false)).not.toEqual(selectSQLiteBenchmarkWorkload(true));
  });

  it('records batch write throughput and verifies stored data', async () => {
    const storage = createStorage();
    const value = generateCheckpointValue();

    const { medianWritesPerSecond, writesPerSecondSamples } = await runBatchWriteBenchmark(
      storage,
      value,
      integrityWorkload,
    );

    console.log(
      [
        `\n  SQLite batch write benchmark:`,
        `    Total writes:    ${integrityWorkload.batchWriteTotal.toLocaleString()}`,
        `    Value size:      ${value.byteLength} bytes`,
        `    Batch size:      ${integrityWorkload.batchWriteBatchSize.toLocaleString()}`,
        `    Samples:         ${writesPerSecondSamples.map((sample) => Math.round(sample).toLocaleString()).join(', ')}`,
        `    Median writes/sec:${medianWritesPerSecond.toLocaleString()}`,
        `    Target:          ${TARGET_WRITES_PER_SECOND.toLocaleString()}`,
        `    Headroom:        ${((medianWritesPerSecond / TARGET_WRITES_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianWritesPerSecond).toBeGreaterThan(0);

    // Verify data integrity: spot-check a few entries from the final sample.
    const lastSamplePrefix = `${integrityWorkload.batchWriteSampleSize - 1}`;
    const first = await storage.get(`wf:${lastSamplePrefix}:0000000000:ckpt`);
    expect(first).toEqual(value);

    const last = await storage.get(
      `wf:${lastSamplePrefix}:${String(integrityWorkload.batchWriteTotal - 1).padStart(10, '0')}:ckpt`,
    );
    expect(last).toEqual(value);

    storage[Symbol.dispose]();
  }, 15_000);

  runSQLiteArchitectureBenchmark(
    `median batch writes exceed ${TARGET_WRITES_PER_SECOND.toLocaleString()} writes/sec`,
    async () => {
      const storage = createStorage();
      const value = generateCheckpointValue();

      const { medianWritesPerSecond } = await runBatchWriteBenchmark(
        storage,
        value,
        selectSQLiteBenchmarkWorkload(true),
      );
      expect(medianWritesPerSecond).toBeGreaterThanOrEqual(TARGET_WRITES_PER_SECOND);

      storage[Symbol.dispose]();
    },
  );

  it('individual put throughput via batch (single-operation batches)', async () => {
    const storage = createStorage();
    const value = generateCheckpointValue();

    // Warm up
    await storage.put('warmup', value);

    const totalWrites = benchmarkWorkload.individualPutTotal;

    // Pre-generate keys
    const keys = Array.from(
      { length: totalWrites },
      (_, index) => `wf:${String(index).padStart(10, '0')}:ckpt`,
    );

    const start = performance.now();

    for (const key of keys) {
      await storage.put(key, value);
    }

    const elapsed = performance.now() - start;
    const writesPerSecond = Math.round((totalWrites / elapsed) * 1000);

    console.log(
      [
        `\n  SQLite individual put benchmark:`,
        `    Total writes:    ${totalWrites.toLocaleString()}`,
        `    Value size:      ${value.byteLength} bytes`,
        `    Elapsed:         ${elapsed.toFixed(1)}ms`,
        `    Writes/sec:      ${writesPerSecond.toLocaleString()}\n`,
      ].join('\n'),
    );

    // Individual puts (no explicit transaction) are expected to be slower.
    // This test documents the baseline; the batch path is what matters for the 50K target.
    expect(writesPerSecond).toBeGreaterThan(0);

    storage[Symbol.dispose]();
  });

  it(
    'mixed batch operations (puts + deletes) maintain throughput',
    async () => {
      const storage = createStorage();
      const value = generateCheckpointValue();
      const totalOperations = benchmarkWorkload.mixedOperationTotal;
      const batchSize = benchmarkWorkload.mixedOperationBatchSize;
      const batches = totalOperations / batchSize;

      // Seed data to delete
      const seedOperations: BatchOperation[] = Array.from(
        { length: totalOperations / 5 },
        (_, index) => ({
          type: 'put' as const,
          key: `seed:${String(index).padStart(10, '0')}`,
          value,
        }),
      );
      await storage.batch(seedOperations);

      // Pre-generate mixed operations: 80% puts, 20% deletes
      const allBatches: BatchOperation[][] = Array.from({ length: batches }, (_b, batchIndex) =>
        Array.from({ length: batchSize }, (_i, itemIndex) => {
          const globalIndex = batchIndex * batchSize + itemIndex;
          if (globalIndex % 5 === 0 && globalIndex / 5 < totalOperations / 5) {
            return {
              type: 'delete' as const,
              key: `seed:${String(globalIndex / 5).padStart(10, '0')}`,
            };
          }
          return {
            type: 'put' as const,
            key: `mixed:${String(globalIndex).padStart(10, '0')}`,
            value,
          };
        }),
      );

      const start = performance.now();

      for (const batch of allBatches) {
        await storage.batch(batch);
      }

      const elapsed = performance.now() - start;
      const operationsPerSecond = Math.round((totalOperations / elapsed) * 1000);

      console.log(
        [
          `\n  SQLite mixed batch benchmark:`,
          `    Total operations: ${totalOperations.toLocaleString()} (80% put, 20% delete)`,
          `    Value size:       ${value.byteLength} bytes`,
          `    Batch size:       ${batchSize.toLocaleString()}`,
          `    Elapsed:          ${elapsed.toFixed(1)}ms`,
          `    Operations/sec:   ${operationsPerSecond.toLocaleString()}\n`,
        ].join('\n'),
      );

      expect(operationsPerSecond).toBeGreaterThan(0);

      const seedCount = totalOperations / 5;
      expect(await storage.get('seed:0000000000')).toBeNull();
      expect(await storage.get(`seed:${String(seedCount - 1).padStart(10, '0')}`)).toBeNull();
      expect(await storage.get('mixed:0000000001')).toEqual(value);
      expect(await storage.get(`mixed:${String(totalOperations - 1).padStart(10, '0')}`)).toEqual(
        value,
      );

      storage[Symbol.dispose]();
    },
    { timeout: 15_000 },
  );
});
