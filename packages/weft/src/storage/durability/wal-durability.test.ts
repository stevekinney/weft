/**
 * WAL-mode on-disk durability baseline.
 *
 * Per adapter:
 *   1. Round-trip: write → close → reopen → assert byte-identical reads.
 *   2. WAL self-sufficiency after explicit TRUNCATE checkpoint (Bun and
 *      Node only). After a successful checkpoint and clean close, the
 *      `-wal` file is no longer required for correctness — the test
 *      removes it and reopens to prove the main DB file alone is enough.
 *      It does NOT claim "deleting both `-wal` and `-shm` is safe in
 *      general" — `-shm` is a private SQLite shared-memory artifact and
 *      removing it under SQLite has undocumented behavior. The narrow
 *      invariant is documented at the call site. Turso runs the libSQL
 *      equivalent: write → close → reopen with a fresh client against the
 *      same `file:` URL.
 *   3. Multi-session continuity: alternating write/close/reopen across
 *      multiple sessions.
 *
 * To break this test manually (negative-control documentation): edit
 * `src/storage/bun-sql.ts` and replace `PRAGMA journal_mode = WAL` with
 * `PRAGMA journal_mode = OFF`, then rerun. Revert before committing.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  availableAdapterSpecs,
  closeIfOpen,
  FixtureScope,
  type OpenedAdapter,
} from './adapter-spec.test-support.ts';

function bytesEqual(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull();
  expect(Array.from(actual!)).toEqual(Array.from(expected));
}

for (const spec of availableAdapterSpecs()) {
  describe(`WAL durability — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('write → close → reopen preserves all values byte-for-byte', async () => {
      let writer: OpenedAdapter | undefined;
      let reader: OpenedAdapter | undefined;
      try {
        const directory = scope.makeTempDirectory('wal-roundtrip');
        const databasePath = join(directory, 'weft.db');

        writer = await spec.open(databasePath);
        await writer.storage.put('single:a', new Uint8Array([1, 2, 3]));
        await writer.storage.put('single:b', new Uint8Array([4, 5, 6]));
        await writer.storage.batch([
          { type: 'put', key: 'batch:x', value: new Uint8Array([7, 8, 9]) },
          { type: 'put', key: 'batch:y', value: new Uint8Array([10, 11, 12]) },
        ]);
        await writer.close();
        writer = undefined;

        reader = await spec.open(databasePath);
        bytesEqual(await reader.storage.get('single:a'), new Uint8Array([1, 2, 3]));
        bytesEqual(await reader.storage.get('single:b'), new Uint8Array([4, 5, 6]));
        bytesEqual(await reader.storage.get('batch:x'), new Uint8Array([7, 8, 9]));
        bytesEqual(await reader.storage.get('batch:y'), new Uint8Array([10, 11, 12]));
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(writer);
        await closeIfOpen(reader);
      }
    });

    if (spec.exposesStandardSidecars) {
      it('after explicit TRUNCATE checkpoint, the WAL file is no longer required', async () => {
        let writer: OpenedAdapter | undefined;
        let checkpointer: OpenedAdapter | undefined;
        let reader: OpenedAdapter | undefined;
        try {
          const directory = scope.makeTempDirectory('wal-truncate');
          const databasePath = join(directory, 'weft.db');

          writer = await spec.open(databasePath);
          await writer.storage.put('keep:me', new Uint8Array([42]));
          await writer.storage.batch([
            { type: 'put', key: 'keep:also', value: new Uint8Array([43]) },
          ]);
          await writer.close();
          writer = undefined;

          // Checkpoint runs after the writer is closed so the sibling
          // connection has exclusive access. `truncated === true` is a
          // tight assertion: it requires `busy === 0`, every WAL frame
          // mirrored into the main DB (`log === checkpointed`), AND a
          // zero-byte or absent `-wal` file on disk.
          checkpointer = await spec.open(databasePath);
          const result = await checkpointer.checkpoint();
          expect(result.truncated).toBe(true);
          await checkpointer.close();
          checkpointer = undefined;

          // Narrow invariant: after a successful TRUNCATE checkpoint, the
          // WAL file is no longer required for correctness. We do NOT
          // delete `-shm` because that is a private SQLite shared-memory
          // artifact with undocumented deletion behavior on some platforms
          // (notably bun:sqlite on macOS).
          const walPath = `${databasePath}-wal`;
          if (existsSync(walPath)) unlinkSync(walPath);

          reader = await spec.open(databasePath);
          bytesEqual(await reader.storage.get('keep:me'), new Uint8Array([42]));
          bytesEqual(await reader.storage.get('keep:also'), new Uint8Array([43]));
        } catch (error) {
          scope.markFailed();
          throw error;
        } finally {
          await closeIfOpen(writer);
          await closeIfOpen(checkpointer);
          await closeIfOpen(reader);
        }
      });
    } else {
      it('libSQL local-file: fresh client against same `file:` URL reads all prior values', async () => {
        let writer: OpenedAdapter | undefined;
        let reader: OpenedAdapter | undefined;
        try {
          const directory = scope.makeTempDirectory('libsql-reopen');
          const databasePath = join(directory, 'weft.db');

          writer = await spec.open(databasePath);
          await writer.storage.put('keep:me', new Uint8Array([42]));
          await writer.storage.batch([
            { type: 'put', key: 'keep:also', value: new Uint8Array([43]) },
          ]);
          await writer.close();
          writer = undefined;

          reader = await spec.open(databasePath);
          bytesEqual(await reader.storage.get('keep:me'), new Uint8Array([42]));
          bytesEqual(await reader.storage.get('keep:also'), new Uint8Array([43]));
        } catch (error) {
          scope.markFailed();
          throw error;
        } finally {
          await closeIfOpen(writer);
          await closeIfOpen(reader);
        }
      });
    }

    it('multi-session continuity preserves writes across three open/close cycles', async () => {
      let session1: OpenedAdapter | undefined;
      let session2: OpenedAdapter | undefined;
      let session3: OpenedAdapter | undefined;
      try {
        const directory = scope.makeTempDirectory('wal-multisession');
        const databasePath = join(directory, 'weft.db');

        session1 = await spec.open(databasePath);
        await session1.storage.put('session:1', new Uint8Array([1]));
        await session1.close();
        session1 = undefined;

        session2 = await spec.open(databasePath);
        await session2.storage.put('session:2', new Uint8Array([2]));
        await session2.close();
        session2 = undefined;

        session3 = await spec.open(databasePath);
        bytesEqual(await session3.storage.get('session:1'), new Uint8Array([1]));
        bytesEqual(await session3.storage.get('session:2'), new Uint8Array([2]));
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(session1);
        await closeIfOpen(session2);
        await closeIfOpen(session3);
      }
    });
  });
}
