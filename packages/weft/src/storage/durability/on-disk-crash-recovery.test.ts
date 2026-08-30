/**
 * Engine recovery against an on-disk SQLite file.
 *
 * Each test asserts a specific recovery invariant. The pattern mirrors the
 * in-memory recovery suite in `src/core/crash-recovery.test.ts`:
 *
 *   1. Engine1 opens an adapter at an on-disk path, runs a minimal
 *      workflow to its parking point, flushes async work.
 *   2. The test inspects storage through the `Storage` interface and
 *      asserts the recovery-relevant records were written. Without this
 *      runtime check, a test could pass because the workflow never
 *      reached the intended state.
 *   3. Engine1 and its storage are disposed cleanly. A FRESH storage
 *      instance is opened against the same on-disk path and handed to a
 *      fresh Engine2.
 *   4. Engine2.recoverAll() runs and the invariant is checked.
 *
 * Important framing: this is "fresh adapter against the same on-disk
 * file," not a subprocess-kill recovery. The SIGKILL-recovery path for
 * the engine layer is covered by `src/testing/subprocess-engine.test.ts`.
 * This file's claim is "engine state persisted to on-disk SQLite during
 * steady-state operation is recoverable by a fresh Engine instance
 * against the same file."
 *
 * Bun-only at present: `better-sqlite3` cannot load under Bun
 * (oven-sh/bun#4290), so `NodeSQLiteStorage` integration variants are
 * skipped in this runtime. Adapter-level durability is established for
 * Node-SQLite by the other deliverables in `src/storage/durability/`
 * when run under Node; engine recovery uses the shared `recoverAll()`
 * code path on top of the `Storage` interface, so its behavior does not
 * vary across adapters that share the same Storage contract.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { BunSQLiteStorage } from '../bun-sql.ts';
import { KEYS as STORAGE_KEYS } from '../interface.ts';

import { workflow } from '../../core/types.ts';
import { FixtureScope } from './adapter-spec.test-support.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function openStorage(databasePath: string): BunSQLiteStorage {
  return new BunSQLiteStorage(databasePath);
}

function safeDisposeEngine(engine: Engine | undefined): void {
  if (engine === undefined) return;
  try {
    engine[Symbol.dispose]();
  } catch {
    // best-effort
  }
}

function safeDisposeStorage(storage: BunSQLiteStorage | undefined): void {
  if (storage === undefined) return;
  try {
    storage[Symbol.dispose]();
  } catch {
    // best-effort
  }
}

describe('on-disk crash recovery — BunSQLiteStorage', () => {
  let scope: FixtureScope;

  beforeEach(() => {
    scope = new FixtureScope();
  });

  afterEach(() => {
    scope.cleanup();
  });

  it('pending-signal workflow resumes against a fresh Engine + fresh adapter', async () => {
    let storage1: BunSQLiteStorage | undefined;
    let storage2: BunSQLiteStorage | undefined;
    let engine1: Engine | undefined;
    let engine2: Engine | undefined;
    try {
      const directory = scope.makeTempDirectory('recovery-signal');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const result = yield* ctx.waitForSignal('go');
          return `recovered:${String(result)}`;
        };
      }

      storage1 = openStorage(databasePath);
      engine1 = new Engine({ storage: storage1 });
      const signalResumeWorkflow = workflow({ name: 'signal-resume' }).execute(makeWorkflow());
      engine1.register(signalResumeWorkflow);
      await engine1.start('signal-resume', null, { id: 'wf-signal' });
      await flush();

      // Persistence assertion: the workflow record must be on disk before
      // Engine2 is constructed.
      const workflowKey = STORAGE_KEYS.workflow('wf-signal');
      expect(await storage1.get(workflowKey)).not.toBeNull();
      // Strict disposal on the happy path; `safeDispose*` is reserved for
      // `finally` cleanup so it does not mask a prior assertion error.
      engine1[Symbol.dispose]();
      engine1 = undefined;
      storage1[Symbol.dispose]();
      storage1 = undefined;

      storage2 = openStorage(databasePath);
      engine2 = new Engine({ storage: storage2 });
      const signalResumeWorkflow2 = workflow({ name: 'signal-resume' }).execute(makeWorkflow());
      engine2.register(signalResumeWorkflow2);

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(1);
      await flush();

      await engine2.signal('wf-signal', 'go', 'payload');
      const result = await handles[0]!.result();
      expect(result).toBe('recovered:payload');
    } catch (error) {
      scope.markFailed();
      throw error;
    } finally {
      safeDisposeEngine(engine1);
      safeDisposeEngine(engine2);
      safeDisposeStorage(storage1);
      safeDisposeStorage(storage2);
    }
  });

  it('completed workflow is not re-resumed against a fresh adapter', async () => {
    let storage1: BunSQLiteStorage | undefined;
    let storage2: BunSQLiteStorage | undefined;
    let engine1: Engine | undefined;
    let engine2: Engine | undefined;
    try {
      const directory = scope.makeTempDirectory('recovery-completed');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* () {
          return 'done';
        };
      }

      storage1 = openStorage(databasePath);
      engine1 = new Engine({ storage: storage1 });
      const completedOnceWorkflow = workflow({ name: 'completed-once' }).execute(makeWorkflow());
      engine1.register(completedOnceWorkflow);
      const initialHandle = await engine1.start('completed-once', null, { id: 'wf-done' });
      const firstResult = await initialHandle.result();
      expect(firstResult).toBe('done');
      await flush();

      expect(await storage1.get(STORAGE_KEYS.workflow('wf-done'))).not.toBeNull();
      // Strict disposal on the happy path; `safeDispose*` is reserved for
      // `finally` cleanup so it does not mask a prior assertion error.
      engine1[Symbol.dispose]();
      engine1 = undefined;
      storage1[Symbol.dispose]();
      storage1 = undefined;

      storage2 = openStorage(databasePath);
      engine2 = new Engine({ storage: storage2 });
      const completedOnceWorkflow2 = workflow({ name: 'completed-once' }).execute(makeWorkflow());
      engine2.register(completedOnceWorkflow2);

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(0);
    } catch (error) {
      scope.markFailed();
      throw error;
    } finally {
      safeDisposeEngine(engine1);
      safeDisposeEngine(engine2);
      safeDisposeStorage(storage1);
      safeDisposeStorage(storage2);
    }
  });

  it('event log persists across reopen and recovery preserves replay state', async () => {
    let storage1: BunSQLiteStorage | undefined;
    let storage2: BunSQLiteStorage | undefined;
    let engine1: Engine | undefined;
    let engine2: Engine | undefined;
    try {
      const directory = scope.makeTempDirectory('recovery-events');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const first = yield* ctx.waitForSignal('step1');
          const second = yield* ctx.waitForSignal('step2');
          return `${String(first)}/${String(second)}`;
        };
      }

      storage1 = openStorage(databasePath);
      engine1 = new Engine({ storage: storage1 });
      const twoSignalWorkflow = workflow({ name: 'two-signal' }).execute(makeWorkflow());
      engine1.register(twoSignalWorkflow);
      await engine1.start('two-signal', null, { id: 'wf-two' });
      await flush();

      await engine1.signal('wf-two', 'step1', 'A');
      await flush();

      // Confirm at least one event record exists for the workflow on disk
      // before we abandon Engine1.
      const eventPrefix = STORAGE_KEYS.eventPrefix('wf-two');
      let eventCount = 0;
      for await (const _entry of storage1.scan(eventPrefix)) {
        eventCount++;
      }
      expect(eventCount).toBeGreaterThan(0);
      // Strict disposal on the happy path; `safeDispose*` is reserved for
      // `finally` cleanup so it does not mask a prior assertion error.
      engine1[Symbol.dispose]();
      engine1 = undefined;
      storage1[Symbol.dispose]();
      storage1 = undefined;

      storage2 = openStorage(databasePath);
      engine2 = new Engine({ storage: storage2 });
      const twoSignalWorkflow2 = workflow({ name: 'two-signal' }).execute(makeWorkflow());
      engine2.register(twoSignalWorkflow2);

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(1);
      await flush();

      await engine2.signal('wf-two', 'step2', 'B');
      const result = await handles[0]!.result();
      expect(result).toBe('A/B');
    } catch (error) {
      scope.markFailed();
      throw error;
    } finally {
      safeDisposeEngine(engine1);
      safeDisposeEngine(engine2);
      safeDisposeStorage(storage1);
      safeDisposeStorage(storage2);
    }
  });

  it('storage scan order is stable across reopen for recoverable handles', async () => {
    let storage1: BunSQLiteStorage | undefined;
    let storage2: BunSQLiteStorage | undefined;
    let engine1: Engine | undefined;
    let engine2: Engine | undefined;
    try {
      const directory = scope.makeTempDirectory('recovery-scan-order');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const value = yield* ctx.waitForSignal('release');
          return value;
        };
      }

      storage1 = openStorage(databasePath);
      engine1 = new Engine({ storage: storage1 });
      const scanOrderWorkflow = workflow({ name: 'scan-order' }).execute(makeWorkflow());
      engine1.register(scanOrderWorkflow);
      await engine1.start('scan-order', null, { id: 'aaa' });
      await engine1.start('scan-order', null, { id: 'bbb' });
      await engine1.start('scan-order', null, { id: 'ccc' });
      await flush();

      expect(await storage1.get(STORAGE_KEYS.workflow('aaa'))).not.toBeNull();
      expect(await storage1.get(STORAGE_KEYS.workflow('bbb'))).not.toBeNull();
      expect(await storage1.get(STORAGE_KEYS.workflow('ccc'))).not.toBeNull();
      // Strict disposal on the happy path; `safeDispose*` is reserved for
      // `finally` cleanup so it does not mask a prior assertion error.
      engine1[Symbol.dispose]();
      engine1 = undefined;
      storage1[Symbol.dispose]();
      storage1 = undefined;

      storage2 = openStorage(databasePath);
      engine2 = new Engine({ storage: storage2 });
      const scanOrderWorkflow2 = workflow({ name: 'scan-order' }).execute(makeWorkflow());
      engine2.register(scanOrderWorkflow2);

      const handles = await engine2.recoverAll();
      expect(handles.map((handle) => handle.id)).toEqual(['aaa', 'bbb', 'ccc']);
    } catch (error) {
      scope.markFailed();
      throw error;
    } finally {
      safeDisposeEngine(engine1);
      safeDisposeEngine(engine2);
      safeDisposeStorage(storage1);
      safeDisposeStorage(storage2);
    }
  });
});
