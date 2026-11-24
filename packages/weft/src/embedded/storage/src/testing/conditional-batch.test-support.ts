import { describe, expect, it } from 'bun:test';

import type { Storage } from '../interface.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A storage backend the conditional-batch tests run against: its name and a fresh-instance factory. */
export type ConditionalBatchBackend = {
  /** The name the registered tests carry. */
  readonly name: string;
  /** Build a fresh, isolated storage and the cleanup that releases it. */
  readonly factory: () => { storage: Storage; cleanup: () => void | Promise<void> };
};

/**
 * Register the conditional-batch tests (commit on match, no writes on mismatch, `null` as
 * absence) for one storage backend.
 */
export function describeConditionalBatch(backend: ConditionalBatchBackend): void {
  describe(`${backend.name} conditional batch`, () => {
    it('commits a batch when every condition matches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('before') }],
          [
            { type: 'put', key: 'condition:match', value: encode('after') },
            { type: 'put', key: 'condition:new', value: encode('created') },
          ],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:match')).toEqual(encode('after'));
        expect(await storage.get('condition:new')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });

    it('does not apply writes when a condition mismatches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('stale') }],
          [{ type: 'put', key: 'condition:match', value: encode('after') }],
        );

        expect(committed).toBe(false);
        expect(await storage.get('condition:match')).toEqual(encode('before'));
      } finally {
        cleanup();
      }
    });

    it('treats null expected values as key absence', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:missing', expectedValue: null }],
          [{ type: 'put', key: 'condition:missing', value: encode('created') }],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:missing')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });
  });
}
