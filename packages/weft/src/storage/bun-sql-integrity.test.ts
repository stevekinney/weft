import { afterEach, describe, expect, it } from 'bun:test';

import type { BatchOperation } from './interface.ts';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../testing/storage-backends.test-support.ts';
import {
  ARCHITECTURE_BENCHMARK_WORKLOAD,
  benchmarkWorkload,
  generateCheckpointValue,
  INTEGRITY_WORKLOAD,
  median,
  runBatchWriteBenchmark,
  selectSQLiteBenchmarkWorkload,
  TARGET_WRITES_PER_SECOND,
} from './bun-sql-workload.test-support.ts';
import { BunSQLiteStorage } from './bun-sql.ts';

const integrityWorkload = selectSQLiteBenchmarkWorkload(false);

describe('BunSQLiteStorage integrity', () => {
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

  it('takes the median of an unsorted sample set', () => {
    // The integrity workload runs a single throughput sample, so its own batch-write test never
    // gives the sort comparator two values to compare; this covers the helper directly.
    expect(median([30, 10, 20])).toBe(20);
    expect(median([7])).toBe(7);
  });

  it('writes batches and verifies stored data', async () => {
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

  it('stores individual puts as single-operation batches and reads back the first and last keys', async () => {
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

    // Individual puts (no explicit transaction) are expected to be slower. The timing above is
    // logged for the record; the assertions read back stored data.
    expect(await storage.get(keys[0]!)).toEqual(value);
    expect(await storage.get(keys[keys.length - 1]!)).toEqual(value);

    storage[Symbol.dispose]();
  });

  it(
    'applies mixed put and delete batches and reads back stored and deleted keys',
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
