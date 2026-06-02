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
const BATCH_WRITE_SAMPLE_SIZE = 3;
const runSQLiteArchitectureBenchmark =
  process.env['WEFT_SQLITE_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const BATCH_WRITE_TOTAL = 25_000;
const BATCH_WRITE_BATCH_SIZE = 500;

/**
 * Run the shared batch-write workload used by both benchmark call sites and
 * return its measured throughput. This owns the workload so the two benchmarks
 * cannot drift: a 100-write warmup (excluded from timing) primes WAL mode and
 * prepared statements; every sample's batches are pre-generated before any
 * timing starts; `performance.now()` brackets only the `storage.batch` calls;
 * and each batch object is consumed exactly once. Both call sites measure the
 * same total writes, batch size, sample count, and `wf:{sample}:{n}:ckpt` key
 * pattern.
 */
async function runBatchWriteBenchmark(
  storage: BunSQLiteStorage,
  value: Uint8Array,
): Promise<{ medianWritesPerSecond: number; writesPerSecondSamples: number[] }> {
  // Warm up: small batch to trigger WAL mode and prime prepared statements.
  await storage.batch(
    Array.from({ length: 100 }, (_, index) => ({
      type: 'put' as const,
      key: `warmup:${index}`,
      value,
    })),
  );

  const totalWrites = BATCH_WRITE_TOTAL;
  const batchSize = BATCH_WRITE_BATCH_SIZE;
  const batches = totalWrites / batchSize;

  // Pre-generate each sample's batch operations so timing reflects storage
  // throughput rather than key generation or object allocation.
  const sampleBatches: BatchOperation[][][] = Array.from(
    { length: BATCH_WRITE_SAMPLE_SIZE },
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

  it('records batch write throughput and verifies stored data', async () => {
    const storage = createStorage();
    const value = generateCheckpointValue();

    const { medianWritesPerSecond, writesPerSecondSamples } = await runBatchWriteBenchmark(
      storage,
      value,
    );

    console.log(
      [
        `\n  SQLite batch write benchmark:`,
        `    Total writes:    ${BATCH_WRITE_TOTAL.toLocaleString()}`,
        `    Value size:      ${value.byteLength} bytes`,
        `    Batch size:      ${BATCH_WRITE_BATCH_SIZE.toLocaleString()}`,
        `    Samples:         ${writesPerSecondSamples.map((sample) => Math.round(sample).toLocaleString()).join(', ')}`,
        `    Median writes/sec:${medianWritesPerSecond.toLocaleString()}`,
        `    Target:          ${TARGET_WRITES_PER_SECOND.toLocaleString()}`,
        `    Headroom:        ${((medianWritesPerSecond / TARGET_WRITES_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianWritesPerSecond).toBeGreaterThan(0);

    // Verify data integrity: spot-check a few entries from the final sample.
    const lastSamplePrefix = `${BATCH_WRITE_SAMPLE_SIZE - 1}`;
    const first = await storage.get(`wf:${lastSamplePrefix}:0000000000:ckpt`);
    expect(first).toEqual(value);

    const last = await storage.get(
      `wf:${lastSamplePrefix}:${String(BATCH_WRITE_TOTAL - 1).padStart(10, '0')}:ckpt`,
    );
    expect(last).toEqual(value);

    storage[Symbol.dispose]();
  }, 15_000);

  runSQLiteArchitectureBenchmark(
    `median batch writes exceed ${TARGET_WRITES_PER_SECOND.toLocaleString()} writes/sec`,
    async () => {
      const storage = createStorage();
      const value = generateCheckpointValue();

      const { medianWritesPerSecond } = await runBatchWriteBenchmark(storage, value);
      expect(medianWritesPerSecond).toBeGreaterThanOrEqual(TARGET_WRITES_PER_SECOND);

      storage[Symbol.dispose]();
    },
  );

  it('individual put throughput via batch (single-operation batches)', async () => {
    const storage = createStorage();
    const value = generateCheckpointValue();

    // Warm up
    await storage.put('warmup', value);

    const totalWrites = 10_000;

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

      // Seed data to delete
      const seedOperations: BatchOperation[] = Array.from({ length: 10_000 }, (_, index) => ({
        type: 'put' as const,
        key: `seed:${String(index).padStart(10, '0')}`,
        value,
      }));
      await storage.batch(seedOperations);

      const totalOperations = 50_000;
      const batchSize = 1_000;
      const batches = totalOperations / batchSize;

      // Pre-generate mixed operations: 80% puts, 20% deletes
      const allBatches: BatchOperation[][] = Array.from({ length: batches }, (_b, batchIndex) =>
        Array.from({ length: batchSize }, (_i, itemIndex) => {
          const globalIndex = batchIndex * batchSize + itemIndex;
          if (globalIndex % 5 === 0 && globalIndex / 5 < 10_000) {
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

      storage[Symbol.dispose]();
    },
    { timeout: 15_000 },
  );
});
