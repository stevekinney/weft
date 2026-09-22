/**
 * COR-1283: direct unit test for `TrackingScanStorage`'s async-iterator
 * `return()` handler. `storage-raw.test.ts`'s one test that exercises this
 * fixture (`'does not pull scan entries until the NDJSON response body is
 * read'`) ends with `await reader.cancel()`, but the NDJSON streaming
 * response pipeline does not propagate that `ReadableStream` cancellation
 * down into an early `.return()` call on the underlying storage scan
 * iterator — so `return()`, though present to make this fixture a
 * spec-complete async iterator, was never actually invoked by anything.
 * This proves it behaves as an async-iterator `return()` should (settles
 * the iteration as done, without touching `entriesPulled`) for whatever
 * might call it in the future even though nothing does today.
 */
import { describe, expect, it } from 'bun:test';

import { TrackingScanStorage } from './storage.test-support.ts';

describe('TrackingScanStorage — async-iterator return()', () => {
  it('settles as done without pulling another entry when the iterator is closed early', async () => {
    const storage = new TrackingScanStorage();
    const iterator = storage.scan('wf:')[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(storage.entriesPulled).toBe(1);

    const closed = await iterator.return?.();
    expect(closed).toEqual({ done: true, value: undefined });
    // Closing the iterator early must not pull a further entry.
    expect(storage.entriesPulled).toBe(1);
  });
});
