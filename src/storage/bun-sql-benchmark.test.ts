import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BatchOperation } from './interface';

import { BunSQLiteStorage } from './bun-sql';

/** Create a unique temporary file path for each test. */
function createTemporaryPath(): string {
  return join(tmpdir(), `sqlite-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Generate a realistic ~2KB value (typical checkpoint size). */
function generateCheckpointValue(): Uint8Array {
  const value = new Uint8Array(2048);
  crypto.getRandomValues(value);
  return value;
}

/**
 * The minimum throughput target from the architecture doc:
 * "50K+ writes/sec on SQLite. Benchmarked on commodity hardware (M1 MacBook or equivalent)."
 */
const TARGET_WRITES_PER_SECOND = 50_000;

describe('BunSQLiteStorage benchmark', () => {
  const temporaryPaths: string[] = [];

  function createStorage(): BunSQLiteStorage {
    const path = createTemporaryPath();
    temporaryPaths.push(path);
    return new BunSQLiteStorage(path);
  }

  afterEach(() => {
    for (const path of temporaryPaths) {
      if (existsSync(path)) rmSync(path, { force: true });
      // WAL and SHM sidecar files
      if (existsSync(`${path}-wal`)) rmSync(`${path}-wal`, { force: true });
      if (existsSync(`${path}-shm`)) rmSync(`${path}-shm`, { force: true });
    }
    temporaryPaths.length = 0;
  });

  it(`batch writes exceed ${TARGET_WRITES_PER_SECOND.toLocaleString()} writes/sec`, async () => {
    const storage = createStorage();
    const value = generateCheckpointValue();

    // Warm up: small batch to trigger WAL mode and prime prepared statements.
    await storage.batch(
      Array.from({ length: 100 }, (_, index) => ({
        type: 'put' as const,
        key: `warmup:${index}`,
        value,
      })),
    );

    const totalWrites = 100_000;
    const batchSize = 1_000;
    const batches = totalWrites / batchSize;

    // Pre-generate all batch operations to exclude key generation from timing.
    const allBatches: BatchOperation[][] = Array.from({ length: batches }, (_b, batchIndex) =>
      Array.from({ length: batchSize }, (_i, itemIndex) => ({
        type: 'put' as const,
        key: `wf:${String(batchIndex * batchSize + itemIndex).padStart(10, '0')}:ckpt`,
        value,
      })),
    );

    const start = performance.now();

    for (const batch of allBatches) {
      await storage.batch(batch);
    }

    const elapsed = performance.now() - start;
    const writesPerSecond = Math.round((totalWrites / elapsed) * 1000);

    console.log(
      [
        `\n  SQLite batch write benchmark:`,
        `    Total writes:    ${totalWrites.toLocaleString()}`,
        `    Value size:      ${value.byteLength} bytes`,
        `    Batch size:      ${batchSize.toLocaleString()}`,
        `    Elapsed:         ${elapsed.toFixed(1)}ms`,
        `    Writes/sec:      ${writesPerSecond.toLocaleString()}`,
        `    Target:          ${TARGET_WRITES_PER_SECOND.toLocaleString()}`,
        `    Headroom:        ${((writesPerSecond / TARGET_WRITES_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(writesPerSecond).toBeGreaterThanOrEqual(TARGET_WRITES_PER_SECOND);

    // Verify data integrity: spot-check a few entries survived.
    const first = await storage.get('wf:0000000000:ckpt');
    expect(first).toEqual(value);

    const last = await storage.get(`wf:${String(totalWrites - 1).padStart(10, '0')}:ckpt`);
    expect(last).toEqual(value);

    storage[Symbol.dispose]();
  });

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

  it('mixed batch operations (puts + deletes) maintain throughput', async () => {
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

    expect(operationsPerSecond).toBeGreaterThanOrEqual(TARGET_WRITES_PER_SECOND);

    storage[Symbol.dispose]();
  });
});
