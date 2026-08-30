/**
 * Mid-transaction SIGKILL tests.
 *
 * Two complementary tests per adapter:
 *
 *   - 3a (adapter-batch atomicity under SIGKILL): subprocess opens the
 *     real adapter, seeds a pre-batch marker, builds a 50,000-entry
 *     batch in memory, prints `WEFT_DURABILITY_READY`, then immediately
 *     calls `storage.batch(big)`. The parent SIGKILLs after seeing
 *     readiness. The invariant being asserted is all-or-nothing: the
 *     `mid:` row count must be exactly 0 (transaction rolled back) or
 *     exactly 50_000 (transaction committed cleanly before the kill
 *     arrived). Anything in between is partial state — the failure mode
 *     this test exists to detect. The full `mid:` prefix is scanned so
 *     any partial commit is loud.
 *
 *   - 3b (deterministic in-transaction kill, Bun/Node only): subprocess
 *     opens the real adapter to create file/schema/pragmas, disposes,
 *     reopens via a raw `bun:sqlite` / `better-sqlite3` handle with
 *     mirrored pragmas, runs `BEGIN IMMEDIATE` + an INSERT, then prints
 *     `WEFT_DURABILITY_IN_TRANSACTION`. The parent SIGKILLs only after
 *     observing that marker — the kill is guaranteed mid-transaction.
 *     After reopen via the adapter, the in-transaction row is absent.
 *
 * Cleanup invariant: every spawn is wrapped in try/finally. In finally:
 * if the child has not exited, send SIGKILL and race `process.exited`
 * against a 2s timeout. Timeout throws so a leaked subprocess never
 * deadlocks the runner. The reader handle opened in the parent is also
 * closed in `finally` so a thrown assertion never leaves a SQLite handle
 * open against a temp directory that's about to be removed.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  availableAdapterSpecs,
  availableBunNodeAdapterSpecs,
  closeIfOpen,
  FixtureScope,
  type AdapterSpec,
  type BunOrNodeAdapterSpec,
  type OpenedAdapter,
} from './adapter-spec.test-support.ts';

function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const sqliteModuleUrl = import.meta.resolve('../bun-sql.ts');
const nodeSqliteModuleUrl = import.meta.resolve('../node-sqlite.ts');
const tursoModuleUrl = import.meta.resolve('../turso.ts');

type RunningChild = ReturnType<typeof Bun.spawn>;

async function killAndWait(child: RunningChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  const winner = await Promise.race([
    child.exited.then(() => 'exited' as const),
    realSleep(2000).then(() => 'timeout' as const),
  ]);
  if (winner === 'timeout') {
    throw new Error('Subprocess did not exit within 2s after SIGKILL — leak guard fired');
  }
}

function expectReadableStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  label: 'stdout' | 'stderr',
): ReadableStream<Uint8Array> {
  if (stream === undefined || typeof stream === 'number') {
    throw new Error(
      `Expected ${label} to be a piped ReadableStream — got ${typeof stream}. ` +
        `Did the Bun.spawn options forget \`${label}: 'pipe'\`?`,
    );
  }
  return stream;
}

type DrainResult = { text: string; complete: boolean };

/**
 * Drain a stream reader to a string with a bounded deadline.
 *
 * The caller owns the reader (passes it in, owns release/cancel). This
 * shape lets `readUntilMarkerOrExit` keep its existing reader through
 * the early-exit drain instead of releasing-and-reacquiring — releasing
 * while a `reader.read()` is still pending can throw and leave the
 * stream locked, breaking the very drain that follows.
 *
 * The deadline is a hang guard: kernel pipe semantics can have edge
 * cases where the read side does not see EOF immediately even though
 * the producer is gone. The returned `complete` flag reports whether
 * the drain hit EOF (true) or was cut off by the deadline / a cancelled
 * read (false), so callers that depend on a full drain can decide what
 * to do with truncated output.
 *
 * The pending `reader.read()` rejection (which `cancel()` produces on
 * the in-flight read) is mapped to a `cancelled` race outcome via the
 * second handler in `.then`, so a deadline timeout cannot leak an
 * unhandled promise rejection after `Promise.race` resolves.
 */
async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs = 1000,
): Promise<DrainResult> {
  const decoder = new TextDecoder();
  let text = '';
  let complete = false;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const result = await Promise.race([
      reader.read().then(
        (readResult) => ({ kind: 'read' as const, readResult }),
        () => ({ kind: 'cancelled' as const }),
      ),
      realSleep(remaining).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (result.kind === 'timeout') break;
    if (result.kind === 'cancelled') break;
    if (result.readResult.done) {
      complete = true;
      break;
    }
    if (result.readResult.value !== undefined) {
      text += decoder.decode(result.readResult.value, { stream: true });
    }
  }
  // Flush any partial UTF-8 sequence buffered by the decoder.
  text += decoder.decode();
  return { text, complete };
}

/**
 * Drain a stream that the caller does not already hold a reader for.
 *
 * Acquires a reader, drains, then cancels (which releases the lock per
 * the Streams spec). Use this for streams whose lock has never been
 * touched — e.g., stderr that was piped but never read.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  deadlineMs = 1000,
): Promise<DrainResult> {
  const reader = stream.getReader();
  try {
    return await drainReader(reader, deadlineMs);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort — cancel after a closed/errored stream may throw.
    }
  }
}

/**
 * Wait for the marker on stdout or for the subprocess to exit.
 *
 * If the subprocess exits before the marker has been read from the
 * stdout buffer, we drain the remaining stdout first — a fast child can
 * print the marker, exit, and have `child.exited` win the race before
 * the buffered stdout read has resolved. The drain reuses the same
 * stdout reader (no release/reacquire) so a pending `reader.read()`
 * cannot leave the stream locked under our feet. Only after the drain
 * do we decide whether the marker was actually missing. If it was, we
 * throw a diagnostic that includes exit code, signal, full stdout, and
 * any captured stderr — plus an explicit warning if either drain hit
 * its deadline.
 */
async function readUntilMarkerOrExit(
  child: RunningChild,
  marker: string,
  deadlineMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const stdoutStream = expectReadableStream(child.stdout, 'stdout');
  const reader = stdoutStream.getReader();
  let buffer = '';
  const deadline = Date.now() + deadlineMs;
  let earlyExit = false;
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  type WrappedRead = { kind: 'read'; readResult: ReadResult } | { kind: 'read-cancelled' };
  type RaceResult = WrappedRead | { kind: 'exited' } | { kind: 'timeout' };

  // Hoist the pending `reader.read()` outside the race so that when the
  // `exited` branch wins, we don't orphan an in-flight read. Per the
  // Streams spec, reads against a locked reader are FIFO: an orphaned
  // pending read would consume the next chunk and discard it (because
  // the race had already settled), and the drain that follows would
  // start from the chunk AFTER that — losing the marker if it landed
  // in the lost chunk (e.g., marker and exit in the same pipe-buffer
  // flush). Cursor Bugbot caught this on PR #267.
  let pendingRead: Promise<WrappedRead> | undefined;
  const enqueueRead = (): Promise<WrappedRead> => {
    if (pendingRead !== undefined) return pendingRead;
    pendingRead = reader.read().then(
      (readResult): WrappedRead => ({ kind: 'read', readResult }),
      (): WrappedRead => ({ kind: 'read-cancelled' }),
    );
    return pendingRead;
  };

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const result: RaceResult = await Promise.race<RaceResult>([
        enqueueRead(),
        child.exited.then((): RaceResult => ({ kind: 'exited' })),
        realSleep(remaining).then((): RaceResult => ({ kind: 'timeout' })),
      ]);
      if (result.kind === 'exited') {
        earlyExit = true;
        break;
      }
      if (result.kind === 'timeout') break;
      // A read settled. Clear the slot so the next loop iteration (or
      // the early-exit branch below) starts a fresh read instead of
      // re-awaiting an already-resolved promise.
      pendingRead = undefined;
      if (result.kind === 'read-cancelled') break;
      if (result.readResult.done) {
        earlyExit = true;
        break;
      }
      if (result.readResult.value) {
        buffer += decoder.decode(result.readResult.value, { stream: true });
        if (buffer.includes(marker)) {
          await safeCancelReader(reader);
          return buffer;
        }
      }
    }

    if (earlyExit) {
      // If there is still a pending read in flight, drain it FIRST so
      // its chunk is captured rather than orphaned. New reads issued by
      // `drainReader` would otherwise FIFO-queue behind it and miss
      // whatever it consumed.
      if (pendingRead !== undefined) {
        const orphan = await pendingRead;
        pendingRead = undefined;
        if (orphan.kind === 'read' && !orphan.readResult.done && orphan.readResult.value) {
          buffer += decoder.decode(orphan.readResult.value, { stream: true });
          if (buffer.includes(marker)) {
            await safeCancelReader(reader);
            return buffer;
          }
        }
      }
      // Drain remaining stdout using the SAME reader so the lock stays
      // ours throughout — releasing while a `reader.read()` is still
      // pending can throw and leave the stream locked, breaking the
      // marker re-check below.
      const stdoutDrain = await drainReader(reader);
      buffer += stdoutDrain.text;
      await safeCancelReader(reader);
      if (buffer.includes(marker)) return buffer;
      const stderrDrain = await drainStream(expectReadableStream(child.stderr, 'stderr'));
      const drainStatus =
        stdoutDrain.complete && stderrDrain.complete
          ? ''
          : `\nWARNING: drain incomplete (stdout=${stdoutDrain.complete}, stderr=${stderrDrain.complete}) — output may be truncated.`;
      throw new Error(
        `Subprocess exited before marker ${JSON.stringify(marker)} appeared.\n` +
          `exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)}${drainStatus}\n` +
          `stdout:\n${buffer}\nstderr:\n${stderrDrain.text}`,
      );
    }

    await safeCancelReader(reader);
    throw new Error(`Timed out waiting for marker ${JSON.stringify(marker)}.\nstdout:\n${buffer}`);
  } catch (error) {
    await safeCancelReader(reader);
    throw error;
  }
}

async function safeCancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // best-effort — cancel after a closed/errored stream may throw.
  }
}

function importLineFor(spec: AdapterSpec): string {
  switch (spec.name) {
    case 'BunSQLiteStorage':
      return `import { BunSQLiteStorage as Adapter } from ${JSON.stringify(sqliteModuleUrl)};\nfunction openAdapter(path) { return new Adapter(path); }`;
    case 'NodeSQLiteStorage':
      return `import { NodeSQLiteStorage as Adapter } from ${JSON.stringify(nodeSqliteModuleUrl)};\nfunction openAdapter(path) { return new Adapter(path); }`;
    case 'TursoStorage':
      return `import { TursoStorage as Adapter } from ${JSON.stringify(tursoModuleUrl)};\nfunction openAdapter(path) { return new Adapter({ url: 'file:' + path }); }`;
  }
}

function adapterBatchEntrypointSource(spec: AdapterSpec): string {
  // Construct the 50,000-entry batch BEFORE emitting the readiness marker
  // so the kill cannot land during plain JS array construction — only
  // after the adapter's `batch()` has been scheduled. The parent reads
  // `WEFT_DURABILITY_READY` exactly when the next line is `await
  // storage.batch(big)`.
  return `
${importLineFor(spec)}

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
const big = [];
for (let index = 0; index < 50000; index++) {
  big.push({
    type: 'put',
    key: 'mid:' + index.toString().padStart(8, '0'),
    value: new Uint8Array([index & 0xff]),
  });
}
process.stdout.write('WEFT_DURABILITY_READY\\n');
await storage.batch(big);
process.stdout.write('WEFT_DURABILITY_UNREACHABLE\\n');
`;
}

function rawInTransactionEntrypointSource(spec: BunOrNodeAdapterSpec): string {
  if (spec.name === 'BunSQLiteStorage') {
    return `
${importLineFor(spec)}
import { Database } from 'bun:sqlite';

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
storage[Symbol.dispose]();

const database = new Database(databasePath);
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA synchronous = NORMAL');
database.exec('BEGIN IMMEDIATE');
const insert = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
insert.run('mid:in-transaction', new Uint8Array([42]));
process.stdout.write('WEFT_DURABILITY_IN_TRANSACTION\\n');
await new Promise(() => {});
`;
  }
  // NodeSQLiteStorage
  return `
${importLineFor(spec)}
import { createRequire } from 'node:module';

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
storage[Symbol.dispose]();

const requireFromHere = createRequire(import.meta.url);
const BetterSqlite3 = requireFromHere('better-sqlite3');
const database = new BetterSqlite3(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.exec('BEGIN IMMEDIATE');
const insert = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
insert.run('mid:in-transaction', new Uint8Array([42]));
process.stdout.write('WEFT_DURABILITY_IN_TRANSACTION\\n');
await new Promise(() => {});
`;
}

async function countMidRows(reader: OpenedAdapter): Promise<number> {
  let count = 0;
  for await (const _entry of reader.storage.scan('mid:')) {
    count++;
  }
  return count;
}

for (const spec of availableAdapterSpecs()) {
  describe(`mid-transaction kill (3a, adapter batch) — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('SIGKILL around the adapter batch call leaves an all-or-nothing outcome (no partial rows)', async () => {
      const directory = scope.makeTempDirectory('batch-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      await Bun.write(entrypointPath, adapterBatchEntrypointSource(spec));

      const child = Bun.spawn({
        cmd: ['bun', entrypointPath, databasePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const totalBatchEntries = 50_000;
      let reader: OpenedAdapter | undefined;
      try {
        await readUntilMarkerOrExit(child, 'WEFT_DURABILITY_READY', 5000);
        await killAndWait(child);

        reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();

        // The atomicity invariant: the SIGKILL must leave the database
        // in exactly one of the two valid pre-/post-batch states. Either
        // the WAL rolled back the transaction (count = 0) or it
        // committed cleanly before the kill arrived (count = total).
        // Anything in between proves the batch is non-atomic and is the
        // failure mode this test exists to catch.
        const midCount = await countMidRows(reader);
        expect(midCount === 0 || midCount === totalBatchEntries).toBe(true);
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(reader);
        await killAndWait(child);
      }
    }, 15_000);
  });
}

for (const spec of availableBunNodeAdapterSpecs()) {
  describe(`mid-transaction kill (3b, deterministic) — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('SIGKILL after BEGIN+INSERT, before COMMIT, rolls back the in-transaction row', async () => {
      const directory = scope.makeTempDirectory('in-transaction-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      await Bun.write(entrypointPath, rawInTransactionEntrypointSource(spec));

      const child = Bun.spawn({
        cmd: ['bun', entrypointPath, databasePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let reader: OpenedAdapter | undefined;
      try {
        await readUntilMarkerOrExit(child, 'WEFT_DURABILITY_IN_TRANSACTION', 5000);
        await killAndWait(child);

        // Verify the child was actually killed by SIGKILL, not by a crash
        // mid-setup. If the child exited from a thrown error, that's an
        // environment/test bug, not a durability claim.
        expect(child.signalCode).toBe('SIGKILL');

        reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();
        expect(await reader.storage.get('mid:in-transaction')).toBeNull();
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(reader);
        await killAndWait(child);
      }
    }, 15_000);
  });
}
