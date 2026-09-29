import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import type { Storage } from './interface.ts';
import { storageConditionalBatch } from './interface.ts';
import { MemoryStorage } from './memory.ts';
import { copyTextKeyValueRowsToStorage } from './text-value-import.ts';

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

describe('copyTextKeyValueRowsToStorage', () => {
  it('copies text rows into storage as UTF-8 bytes under a target prefix', async () => {
    await using storage = new MemoryStorage();

    const result = await copyTextKeyValueRowsToStorage({
      storage,
      targetPrefix: 'app:my-service',
      rows: [
        { key: 'session:1', value: 'hello' },
        { key: 'session:2', value: 'world' },
      ],
    });

    expect(result).toEqual({ copied: 2 });
    expect(decode(await storage.get('app:my-service:session:1'))).toBe('hello');
    expect(decode(await storage.get('app:my-service:session:2'))).toBe('world');
  });

  it('refuses to overwrite existing target keys', async () => {
    await using storage = new MemoryStorage();
    await storage.put('app:my-service:session:1', new TextEncoder().encode('existing'));

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          targetPrefix: 'app:my-service',
          rows: [{ key: 'session:1', value: 'new' }],
        }),
      ),
    ).toThrow('Target storage already contains key "app:my-service:session:1"');

    expect(decode(await storage.get('app:my-service:session:1'))).toBe('existing');
  });

  it('refuses duplicate source rows that map to the same target key', async () => {
    await using storage = new MemoryStorage();

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          rows: [
            { key: 'same', value: 'first' },
            { key: 'same', value: 'second' },
          ],
        }),
      ),
    ).toThrow('Text key-value import source produced duplicate target key "same"');
  });

  it('rejects rows whose runtime key or value is not text', async () => {
    await using storage = new MemoryStorage();

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          rows: [{ key: 1, value: 'session' } as never],
        }),
      ),
    ).toThrow('Text key-value import rows must have string keys');

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          rows: [{ key: 'session:1', value: 1 } as never],
        }),
      ),
    ).toThrow('Text key-value import rows must have string values');
  });

  it('rejects target keys that would write into Weft reserved keyspace', async () => {
    await using storage = new MemoryStorage();

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          targetPrefix: 'wf',
          rows: [{ key: 'workflow-id', value: 'reserved' }],
        }),
      ),
    ).toThrow('Text key-value import target key "wf:workflow-id" uses a Weft-reserved key prefix');
  });

  it('uses conditionalBatch so target changes during import abort the copy', async () => {
    class RacingStorage extends MemoryStorage {
      override async conditionalBatch(
        conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
        operations: Parameters<MemoryStorage['conditionalBatch']>[1],
      ): Promise<boolean> {
        await this.put('session:1', new TextEncoder().encode('racing'));
        return super.conditionalBatch(conditions, operations);
      }
    }

    await using storage = new RacingStorage();

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage,
          rows: [{ key: 'session:1', value: 'new' }],
        }),
      ),
    ).toThrow('Target storage changed before import could commit');

    expect(decode(await storage.get('session:1'))).toBe('racing');
  });

  it('keeps the target empty when there are no rows', async () => {
    await using storage = new MemoryStorage();

    expect(
      await copyTextKeyValueRowsToStorage({
        storage,
        rows: [],
      }),
    ).toEqual({ copied: 0 });
    expect(await Array.fromAsync(storage.scan(''))).toEqual([]);
  });

  it('fails through the storage capability gate when compare-and-swap is unavailable', async () => {
    await using storage = new MemoryStorage();
    const unavailable: Storage = {
      capabilities: () => ({
        ...storage.capabilities(),
        conditionalBatch: false,
      }),
      get: storage.get.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      scan: storage.scan.bind(storage),
      batch: storage.batch.bind(storage),
      [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
    };

    expect(
      await throwingRejectionOf(
        copyTextKeyValueRowsToStorage({
          storage: unavailable,
          rows: [{ key: 'session:1', value: 'new' }],
        }),
      ),
    ).toThrow('requires storage capability "conditionalBatch"');

    expect(await storageConditionalBatch(storage, [], [])).toBe(true);
  });
});
