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
 * The suite runs under Bun or under Node (the Node SQLite adapter's tests register it from
 * `node --test`, because `better-sqlite3` loads only there), so it starts its children with
 * `spawnPipedWithHangGuard` in `process.execPath`, the runtime the adapter opens in.
 *
 * Cleanup invariant: every spawn is wrapped in try/finally. In finally:
 * if the child has not exited, send SIGKILL and race `process.exited`
 * against a 2s timeout. Timeout throws so a leaked subprocess never
 * deadlocks the runner. The reader handle opened in the parent is also
 * closed in `finally` so a thrown assertion never leaves a SQLite handle
 * open against a temp directory that's about to be removed.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spawnPipedWithHangGuard, type PipedChildProcess } from "../../../../../../test-support/embedded/testing/src/hang-guard.ts";
import { outcomeOf, rethrow } from "../../../../../../test-support/embedded/testing/src/module-scope-scenario.ts";
import { afterAll, describe, expect, it } from 'bun:test';

import { awakeTurns } from "../../../../../../test-support/embedded/testing/src/wait-until.ts";
import {
  closeIfOpen,
  FixtureScope,
  type AdapterSpec,
  type OpenedAdapter,
  type RawHandleAdapterSpec,
} from './adapter-spec.test-support.ts';

/**
 * A `Promise.race` branch that resolves to `value` after `milliseconds` of
 * real time. Returns the timer alongside the promise — every call site
 * below races this against work that usually wins, and must clear the
 * timer once the race settles; an inline
 * `Promise.race([..., new Promise((resolve) => setTimeout(...))])` would
 * leave that `setTimeout` alive for the rest of its duration whenever the
 * OTHER branch wins, which the timer-leak guard reports as a leak.
 */
function realTimeoutBranch<T>(
  milliseconds: number,
  value: T,
): { promise: Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), milliseconds);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

async function killAndWait(child: PipedChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  const timeoutBranch = realTimeoutBranch(2000, 'timeout' as const);
  const winner = await Promise.race([
    child.exited.then(() => 'exited' as const),
    timeoutBranch.promise,
  ]);
  timeoutBranch.clear();
  if (winner === 'timeout') {
    throw new Error('Subprocess did not exit within 2s after SIGKILL — leak guard fired');
  }
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
  for await (const _turn of awakeTurns()) {
    const remaining = Math.max(0, deadline - Date.now());
    const timeoutBranch = realTimeoutBranch(remaining, { kind: 'timeout' as const });
    const result = await Promise.race([
      reader.read().then(
        (readResult) => ({ kind: 'read' as const, readResult }),
        () => ({ kind: 'cancelled' as const }),
      ),
      timeoutBranch.promise,
    ]);
    timeoutBranch.clear();
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
  child: PipedChildProcess,
  marker: string,
  deadlineMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
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
    for await (const _turn of awakeTurns()) {
      const remaining = Math.max(0, deadline - Date.now());
      const timeoutBranch = realTimeoutBranch<RaceResult>(remaining, { kind: 'timeout' });
      const result: RaceResult = await Promise.race<RaceResult>([
        enqueueRead(),
        child.exited.then((): RaceResult => ({ kind: 'exited' })),
        timeoutBranch.promise,
      ]);
      timeoutBranch.clear();
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
      const stderrDrain = await drainStream(child.stderr);
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
  const { moduleSpecifier, exportName, constructorArgument } = spec.child;
  return `import { ${exportName} as Adapter } from ${JSON.stringify(moduleSpecifier)};\nfunction openAdapter(path) { return new Adapter(${constructorArgument}); }`;
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

function rawInTransactionEntrypointSource(spec: RawHandleAdapterSpec): string {
  return `
${importLineFor(spec)}
${spec.rawHandle.childImports}

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
storage[Symbol.dispose]();

${spec.rawHandle.openSource}
database.exec('BEGIN IMMEDIATE');
const insert = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
insert.run('mid:in-transaction', new Uint8Array([42]));
process.stdout.write('WEFT_DURABILITY_IN_TRANSACTION\\n');
// Hold the transaction open until the parent's SIGKILL. A referenced timer keeps the event loop
// alive; an unsettled top-level await does not, and Node exits with code 13 once the loop is empty.
setInterval(() => {}, 2 ** 30);
`;
}

async function countMidRows(reader: OpenedAdapter): Promise<number> {
  let count = 0;
  for await (const _entry of reader.storage.scan('mid:')) {
    count++;
  }
  return count;
}

/**
 * Run the mid-transaction SIGKILL scenarios and register their tests: for every spec, a child killed
 * around the adapter's batch call leaves all or none of the batch; for every raw-handle spec, a child
 * killed after `BEGIN` and an insert, before `COMMIT`, leaves the row absent. The scenarios run while
 * this call is awaited, at module scope, off Bun's per-test clock.
 *
 * @param specs - the disk-backed adapters for the batch-kill scenario
 * @param rawHandleSpecs - the adapters with a raw same-file handle, for the in-transaction scenario
 */
export async function runMidTransactionKillSuite(
  specs: readonly AdapterSpec[],
  rawHandleSpecs: readonly RawHandleAdapterSpec[],
): Promise<void> {
  for (const spec of specs) {
    // The child is SIGKILLed mid-write, so the scenario needs a real process; it runs here, at
    // module scope, off Bun's five-second per-test clock, and the test rethrows its outcome.
    const scope = new FixtureScope();
    const outcome = await outcomeOf(async () => {
      const directory = scope.makeTempDirectory('batch-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      writeFileSync(entrypointPath, adapterBatchEntrypointSource(spec));

      // The child runs in the runtime running this suite, the one the adapter opens in.
      const child = spawnPipedWithHangGuard([process.execPath, entrypointPath, databasePath]);

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
    });

    describe(`mid-transaction kill (3a, adapter batch) — ${spec.name}`, () => {
      afterAll(() => {
        scope.cleanup();
      });

      it('SIGKILL around the adapter batch call leaves an all-or-nothing outcome (no partial rows)', () =>
        rethrow(outcome));
    });
  }

  for (const spec of rawHandleSpecs) {
    // The child is SIGKILLed mid-write, so the scenario needs a real process; it runs here, at
    // module scope, off Bun's five-second per-test clock, and the test rethrows its outcome.
    const scope = new FixtureScope();
    const outcome = await outcomeOf(async () => {
      const directory = scope.makeTempDirectory('in-transaction-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      writeFileSync(entrypointPath, rawInTransactionEntrypointSource(spec));

      // The child runs in the runtime running this suite, the one the adapter opens in.
      const child = spawnPipedWithHangGuard([process.execPath, entrypointPath, databasePath]);

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
    });

    describe(`mid-transaction kill (3b, deterministic) — ${spec.name}`, () => {
      afterAll(() => {
        scope.cleanup();
      });

      it('SIGKILL after BEGIN+INSERT, before COMMIT, rolls back the in-transaction row', () =>
        rethrow(outcome));
    });
  }
}
