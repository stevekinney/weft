import { describe, expect, it } from 'bun:test';

import { textValueStore } from "../embedded/storage/src/index.ts";
import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';

for (const backend of storageBackends) {
  describe(`textValueStore (${backend.name})`, () => {
    it('round-trips UTF-8 text and lists keys under a prefix', async () => {
      const { storage, cleanup } = backend.factory();
      try {
        const store = textValueStore(storage);

        await store.set('jobs:a', 'hello');
        await store.set('jobs:b', 'こんにちは 🌍');

        expect(await store.get('jobs:a')).toBe('hello');
        expect(await store.get('jobs:b')).toBe('こんにちは 🌍');

        const listed = await store.list('jobs:');
        expect(listed.toSorted()).toEqual(['jobs:a', 'jobs:b']);

        expect(await store.deletePrefix('jobs:')).toBe(2);
        expect(await store.list('jobs:')).toEqual([]);
      } finally {
        await teardown(undefined, cleanup);
      }
    });
  });
}
