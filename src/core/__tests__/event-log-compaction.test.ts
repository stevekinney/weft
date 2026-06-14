/**
 * Tests for event-log compaction with an atomic watermark:
 * - `appendCompactionOperations` (delete + watermark batch building)
 * - watermark-seeded `EventLog.verify()` and its concurrent-compaction retry
 * - end-to-end engine compaction (truncation, resume, archival, feed/replay)
 */

import { describe, expect, it, mock } from 'bun:test';

import { hashBytes } from '../../runtime/portable.ts';
import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import {
  appendCompactionOperations,
  isEventLogWatermark,
  MAX_COMPACTION_BATCH,
  readEventLogWatermark,
  serializeDeletedEntries,
  type EventLogWatermark,
} from '../engine/event-log-compaction.ts';
import { COMPACTION_BOUNDARY_KIND } from '../engine/workflow-feed.ts';
import { EventLog } from '../event-log.ts';
import type { ArchiveAdapter, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = async () => null;

/** Drain microtasks so fire-and-forget work (archival) completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Append `count` chained entries to a fresh log and return it. */
async function seedLog(
  storage: MemoryStorage,
  workflowId: string,
  count: number,
): Promise<EventLog> {
  const log = new EventLog(storage, workflowId);
  for (let index = 0; index < count; index += 1) {
    await log.append({ type: 'workflow:checkpoint', payload: { step: index } });
  }
  return log;
}

/** Count surviving numeric event records under `ev:{id}:` (excludes head and watermark). */
async function countEventRecords(storage: Storage, workflowId: string): Promise<number> {
  const headKey = KEYS.eventHead(workflowId);
  const watermarkKey = KEYS.eventWatermark(workflowId);
  let count = 0;
  for await (const [key] of storage.scan(KEYS.eventPrefix(workflowId))) {
    if (key === headKey || key === watermarkKey) continue;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// appendCompactionOperations — batch building
// ---------------------------------------------------------------------------

describe('appendCompactionOperations', () => {
  it('returns null and adds no ops when retentionWindow is disabled', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    const ops: BatchOperation[] = [];

    const result = await appendCompactionOperations(storage, 'wf', 9, null, ops);

    expect(result).toBeNull();
    expect(ops).toHaveLength(0);
  });

  it('emits delete ops for sub-watermark records plus a watermark put, in one ops array', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10); // sequences 0..9, head sequence 9
    const ops: BatchOperation[] = [];

    // retentionWindow 3 → keep 7,8,9 → delete 0..6 → watermark.sequence = 7
    const result = await appendCompactionOperations(storage, 'wf', 9, 3, ops);

    expect(result).not.toBeNull();
    expect(result!.watermark.sequence).toBe(7);
    expect(result!.deletedRange).toEqual({ from: 0, to: 6 });

    const deletes = ops.filter((op) => op.type === 'delete');
    const puts = ops.filter((op) => op.type === 'put');
    expect(deletes).toHaveLength(7);
    expect(deletes.map((op) => op.key)).toEqual(
      Array.from({ length: 7 }, (_, seq) => KEYS.event('wf', seq)),
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(KEYS.eventWatermark('wf'));
  });

  it('seeds watermark.prevHash from the RAW stored bytes of entry (sequence - 1)', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    const ops: BatchOperation[] = [];

    const result = await appendCompactionOperations(storage, 'wf', 9, 3, ops);

    // watermark.sequence = 7, so prevHash must be hash of the RAW bytes of entry 6.
    const entry6Bytes = await storage.get(KEYS.event('wf', 6));
    expect(entry6Bytes).not.toBeNull();
    expect(result!.watermark.prevHash).toBe(hashBytes(entry6Bytes!));

    // And it equals the surviving entry 7's own prevHash field (off-by-one pin).
    const entry7 = decode((await storage.get(KEYS.event('wf', 7)))!) as { prevHash: string };
    expect(result!.watermark.prevHash).toBe(entry7.prevHash);
  });

  it('window 1 keeps only the head entry; window 2 keeps the top two', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 5); // 0..4
    const ops1: BatchOperation[] = [];
    const r1 = await appendCompactionOperations(storage, 'wf', 4, 1, ops1);
    expect(r1!.watermark.sequence).toBe(4); // only entry 4 survives

    const storage2 = new MemoryStorage();
    await seedLog(storage2, 'wf', 5);
    const ops2: BatchOperation[] = [];
    const r2 = await appendCompactionOperations(storage2, 'wf', 4, 2, ops2);
    expect(r2!.watermark.sequence).toBe(3); // entries 3,4 survive
  });

  it('is idempotent: a re-run at the same head with the watermark already at the floor is a no-op', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    const ops1: BatchOperation[] = [];
    const r1 = await appendCompactionOperations(storage, 'wf', 9, 3, ops1);
    await storage.batch(ops1); // commit watermark.sequence = 7

    const ops2: BatchOperation[] = [];
    const r2 = await appendCompactionOperations(storage, 'wf', 9, 3, ops2);
    expect(r1!.watermark.sequence).toBe(7);
    expect(r2).toBeNull();
    expect(ops2).toHaveLength(0);
  });

  it('caps a large backlog at MAX_COMPACTION_BATCH and advances incrementally', async () => {
    const storage = new MemoryStorage();
    const total = MAX_COMPACTION_BATCH + 50;
    await seedLog(storage, 'wf', total); // 0 .. total-1
    const headSequence = total - 1;

    // retentionWindow 1 wants firstSurviving = headSequence, but the batch is capped.
    const ops1: BatchOperation[] = [];
    const r1 = await appendCompactionOperations(storage, 'wf', headSequence, 1, ops1);
    expect(r1!.watermark.sequence).toBe(MAX_COMPACTION_BATCH); // 0 .. cap-1 deleted this batch
    expect(r1!.deletedEntries).toHaveLength(MAX_COMPACTION_BATCH);
    await storage.batch(ops1);

    // Next pass advances the rest.
    const ops2: BatchOperation[] = [];
    const r2 = await appendCompactionOperations(storage, 'wf', headSequence, 1, ops2);
    expect(r2!.watermark.sequence).toBe(headSequence);
    await storage.batch(ops2);

    expect(await countEventRecords(storage, 'wf')).toBe(1); // only the head entry remains
    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: true });
  });

  it('aborts (null) when the last-deleted entry is missing, leaving the gap visible', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    // Delete entry 6 so a window-3 compaction (needs entry 6 for prevHash) cannot proceed.
    await storage.delete(KEYS.event('wf', 6));
    const ops: BatchOperation[] = [];

    const result = await appendCompactionOperations(storage, 'wf', 9, 3, ops);
    expect(result).toBeNull();
    expect(ops).toHaveLength(0);
    expect(await readEventLogWatermark(storage, 'wf')).toBeNull();
  });

  it('aborts (null) when the delete range is non-contiguous (a pre-existing gap)', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await storage.delete(KEYS.event('wf', 3)); // gap inside [0,7)
    const ops: BatchOperation[] = [];

    const result = await appendCompactionOperations(storage, 'wf', 9, 3, ops);
    expect(result).toBeNull();
    expect(ops).toHaveLength(0);
  });
});

describe('public export surface', () => {
  it('exports ArchiveAdapter and HistoryPolicy.retentionWindow from the package entry', async () => {
    const entry = await import('../../index.ts');
    // Types are erased at runtime; assert the type-level surface compiles by
    // constructing values typed against the public imports.
    type PublicArchiveAdapter = import('../../index.ts').ArchiveAdapter;
    type PublicHistoryPolicy = import('../../index.ts').HistoryPolicy;
    const adapter: PublicArchiveAdapter = { async store() {} };
    const policy: PublicHistoryPolicy = { retentionWindow: 5 };
    expect(typeof adapter.store).toBe('function');
    expect(policy.retentionWindow).toBe(5);
    // The package entry is a real module (sanity check that the import resolved).
    expect(entry).toBeDefined();
  });
});

describe('isEventLogWatermark', () => {
  it('accepts a valid record and rejects drift', () => {
    const valid: EventLogWatermark = {
      type: 'event-log-watermark',
      version: 1,
      sequence: 5,
      prevHash: 'abc',
      deletedThrough: 4,
    };
    expect(isEventLogWatermark(valid)).toBe(true);
    expect(isEventLogWatermark({ ...valid, type: 'other' })).toBe(false);
    expect(isEventLogWatermark({ ...valid, version: 2 })).toBe(false);
    expect(isEventLogWatermark(null)).toBe(false);
    expect(isEventLogWatermark({ sequence: 1 })).toBe(false);
  });
});

describe('serializeDeletedEntries', () => {
  it('round-trips the raw deleted bytes via the codec', () => {
    const entries = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const decoded = decode(serializeDeletedEntries(entries));
    expect(Array.isArray(decoded)).toBe(true);
    const arr = decoded as Uint8Array[];
    expect([...arr[0]!]).toEqual([1, 2, 3]);
    expect([...arr[1]!]).toEqual([4, 5]);
  });
});

// ---------------------------------------------------------------------------
// verify() — watermark seeding and concurrent-compaction retry
// ---------------------------------------------------------------------------

describe('EventLog.verify() with a watermark', () => {
  async function compactInPlace(
    storage: MemoryStorage,
    workflowId: string,
    retentionWindow: number,
    headSequence: number,
  ): Promise<void> {
    const ops: BatchOperation[] = [];
    await appendCompactionOperations(storage, workflowId, headSequence, retentionWindow, ops);
    await storage.batch(ops);
  }

  it('starts at the watermark with no false break after compaction', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 3, 9);

    expect(await countEventRecords(storage, 'wf')).toBe(3); // 7,8,9
    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: true });
  });

  it('reports a genuine break at the first surviving entry when its prevHash is tampered', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 3, 9);

    // Tamper with the first surviving entry (7): break its prevHash link.
    const { encode } = await import('../codec.ts');
    const entry7 = decode((await storage.get(KEYS.event('wf', 7)))!) as Record<string, unknown>;
    await storage.put(KEYS.event('wf', 7), encode({ ...entry7, prevHash: 'deadbeefdeadbeef' }));

    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: false, firstInvalidSequence: 7 });
  });

  it('flags an empty scan with a present watermark as corruption (first surviving entry gone)', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 3, 9);
    // Delete ALL surviving entries (7,8,9) but leave the watermark.
    for (const seq of [7, 8, 9]) await storage.delete(KEYS.event('wf', seq));

    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: false, firstInvalidSequence: 7 });
  });

  it('retries and stays correct when a compaction commits between watermark read and scan', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    const log = new EventLog(storage, 'wf');

    // No watermark yet. Inject a compaction the first time the watermark is read,
    // so the scan would start at 0 while a watermark now expects 7 (absent→present race).
    const realGet = storage.get.bind(storage);
    let raced = false;
    storage.get = (async (key: string) => {
      if (key === KEYS.eventWatermark('wf') && !raced) {
        raced = true;
        const result = await realGet(key); // null on this first read
        await compactInPlace(storage, 'wf', 3, 9); // advance to watermark 7 mid-verify
        return result;
      }
      return realGet(key);
    }) as typeof storage.get;

    expect(await log.verify()).toEqual({ valid: true });
  });

  it('returns indeterminate when compaction never stabilizes (no false corruption)', async () => {
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 20);
    await compactInPlace(storage, 'wf', 5, 19); // watermark 15
    const log = new EventLog(storage, 'wf');

    // Pathological: every watermark read returns a DIFFERENT, ever-advancing
    // watermark so the first scanned sequence never matches → always 'raced'.
    let fake = 15;
    storage.get = (async (key: string) => {
      if (key === KEYS.eventWatermark('wf')) {
        fake += 1;
        const { encode } = await import('../codec.ts');
        return encode({
          type: 'event-log-watermark',
          version: 1,
          sequence: fake,
          prevHash: 'x',
          deletedThrough: fake - 1,
        });
      }
      // Force the scan to surface a low first sequence that never matches `fake`.
      return new MemoryStorage().get(key);
    }) as typeof storage.get;

    const result = await log.verify();
    expect(result).toEqual({ valid: false, indeterminate: true, reason: 'concurrent-compaction' });
    expect('firstInvalidSequence' in result).toBe(false);
  });

  it('retries to success when a break is explained by a watermark that advanced mid-verify', async () => {
    // Storage actually has watermark 5 and surviving entries 5..9. But the FIRST
    // watermark read returns a STALE watermark (3), so pass 1 scans from key(3),
    // sees entry 5 (5 !== expected 3) → invalid at 3. Re-read shows watermark
    // advanced to 5 → retry. Pass 2 uses watermark 5 and verifies clean.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 5, 9); // real watermark 5, entries 5..9 survive
    const realWatermark = await readEventLogWatermark(storage, 'wf');
    expect(realWatermark!.sequence).toBe(5);

    const { encode } = await import('../codec.ts');
    const realGet = storage.get.bind(storage);
    let firstWatermarkRead = true;
    storage.get = (async (key: string) => {
      if (key === KEYS.eventWatermark('wf') && firstWatermarkRead) {
        firstWatermarkRead = false;
        // Stale lower watermark with a valid (consistent) shape.
        return encode({
          type: 'event-log-watermark',
          version: 1,
          sequence: 3,
          prevHash: realWatermark!.prevHash,
          deletedThrough: 2,
        });
      }
      return realGet(key);
    }) as typeof storage.get;

    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: true });
  });

  it('retries to success when the head advances mid-verify (ordinary append, no compaction)', async () => {
    // No compaction here. Storage has entries 0..9 and a head at sequence 9. The
    // FIRST head read returns a STALE head (sequence 8), so pass 1's tail check
    // sees lastSequence 9 !== stale-head 8 → invalid. The post-scan head re-read
    // returns the real head 9 → headMoved → retry. Pass 2 verifies clean. This is
    // the append-races-verify case that must NOT report false corruption.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    const realHead = decode((await storage.get(KEYS.eventHead('wf')))!) as {
      sequence: number;
      lastHash: string;
    };
    expect(realHead.sequence).toBe(9);

    const { encode } = await import('../codec.ts');
    const realGet = storage.get.bind(storage);
    let firstHeadRead = true;
    storage.get = (async (key: string) => {
      if (key === KEYS.eventHead('wf') && firstHeadRead) {
        firstHeadRead = false;
        // Stale lower head: as if an append committed after this read.
        return encode({ sequence: 8, lastHash: 'stalehash00000000' });
      }
      return realGet(key);
    }) as typeof storage.get;

    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: true });
  });

  it('reports a tampered tail at its own sequence (same last sequence, diverged hash)', async () => {
    // Entries 0..4 with head at 4. Tamper the LAST entry's payload so its bytes
    // hash differently from head.lastHash while keeping sequence 4 and a valid
    // prevHash link. The tail-vs-head check must flag corruption at 4, not 5.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 5);
    const { encode } = await import('../codec.ts');
    const entry4 = decode((await storage.get(KEYS.event('wf', 4)))!) as Record<string, unknown>;
    await storage.put(KEYS.event('wf', 4), encode({ ...entry4, payload: { tampered: true } }));

    const log = new EventLog(storage, 'wf');
    expect(await log.verify()).toEqual({ valid: false, firstInvalidSequence: 4 });
  });

  it('reports corruption when the last record is lost but the head still points past it', async () => {
    // After compaction, watermark 7 and records 7,8,9 survive (head sequence 9).
    // Delete record 9 (the tail) but leave the head record claiming sequence 9.
    // A prefix-only check would see 7,8 as internally consistent and falsely pass;
    // the tail-vs-head cross-check must catch the missing last record.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 3, 9);
    await storage.delete(KEYS.event('wf', 9));

    const log = new EventLog(storage, 'wf');
    // Survivors reach sequence 8; head says 9 → corruption at the missing 9.
    expect(await log.verify()).toEqual({ valid: false, firstInvalidSequence: 9 });
  });

  it('a compacted log fails genesis-rooted verification once its watermark is removed (one-way)', async () => {
    // Rollback safety: a log compacted under the new code, read back by code that
    // ignores the watermark (simulated by deleting the watermark key), must look
    // broken rather than silently valid — pinning that compaction is irreversible.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10);
    await compactInPlace(storage, 'wf', 3, 9); // watermark 7, entries 7..9 survive
    await storage.delete(KEYS.eventWatermark('wf'));

    const log = new EventLog(storage, 'wf');
    // With no watermark, verify expects the first record at sequence 0; the first
    // surviving record is 7, so it reports corruption at the expected sequence 0.
    expect(await log.verify()).toEqual({ valid: false, firstInvalidSequence: 0 });
  });
});

// ---------------------------------------------------------------------------
// End-to-end engine compaction
// ---------------------------------------------------------------------------

function registerCountingWorkflow(engine: Engine, steps: number): void {
  const counting = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
    for (let index = 0; index < steps; index += 1) {
      yield* ctx.run(noop);
    }
    return 'done';
  });
  engine.register(counting);
}

describe('engine event-log compaction', () => {
  it('truncates below the watermark while head/checkpoint survive; verify stays valid', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 2 } });
    registerCountingWorkflow(engine, 6);

    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    // 6 checkpoints (sequences 0..5). retentionWindow 2 keeps at most the last two.
    const watermark = await readEventLogWatermark(storage, handle.id);
    expect(watermark).not.toBeNull();
    expect(watermark!.sequence).toBeGreaterThan(0);
    expect(await countEventRecords(storage, handle.id)).toBeLessThanOrEqual(2);

    // Head and canonical checkpoint are never deleted.
    expect(await storage.get(KEYS.eventHead(handle.id))).not.toBeNull();
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();

    const log = new EventLog(storage, handle.id);
    expect(await log.verify()).toEqual({ valid: true });

    engine[Symbol.dispose]();
  });

  it('disables compaction by default (no retentionWindow) — all records retained', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    registerCountingWorkflow(engine, 6);

    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    expect(await readEventLogWatermark(storage, handle.id)).toBeNull();
    expect(await countEventRecords(storage, handle.id)).toBe(6);

    engine[Symbol.dispose]();
  });

  it('treats retentionWindow: 0 as disabled', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 0 } });
    registerCountingWorkflow(engine, 4);

    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    expect(await readEventLogWatermark(storage, handle.id)).toBeNull();
    expect(await countEventRecords(storage, handle.id)).toBe(4);

    engine[Symbol.dispose]();
  });

  it('the watermark never moves backward when the window is lowered then raised', async () => {
    // Lower window first: compact entries 0..8 with window 1 → watermark 9.
    const storage = new MemoryStorage();
    await seedLog(storage, 'wf', 10); // 0..9
    const tightOps: BatchOperation[] = [];
    const tight = await appendCompactionOperations(storage, 'wf', 9, 1, tightOps);
    await storage.batch(tightOps);
    expect(tight!.watermark.sequence).toBe(9);

    // Raise the window much wider: target boundary (max(0, 9 - 1000 + 1) = 0) is
    // now BELOW the current floor (9). Compaction must be a no-op and leave the
    // watermark exactly where it was — already-deleted history is not restored.
    const wideOps: BatchOperation[] = [];
    const wide = await appendCompactionOperations(storage, 'wf', 9, 1000, wideOps);
    expect(wide).toBeNull();
    expect(wideOps).toHaveLength(0);
    const after = await readEventLogWatermark(storage, 'wf');
    expect(after!.sequence).toBe(9);
  });

  it('resume after compaction chains the next append correctly and stays valid', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 2 } });
    const counting = workflow({ name: 'pausing' }).execute(async function* (ctx: WorkflowContext) {
      for (let index = 0; index < 4; index += 1) {
        yield* ctx.run(noop);
      }
      yield* ctx.sleep('10s'); // park so we can resume
      return 'done';
    });
    engine.register(counting);

    const handle = await engine.start('pausing', null);
    await flush();

    const headBefore = decode((await storage.get(KEYS.eventHead(handle.id)))!) as {
      sequence: number;
      lastHash: string;
    };

    // Resume: rebuilds from the checkpoint, restores head, next append chains on.
    await engine.resume(handle.id);
    await flush();

    const headAfter = decode((await storage.get(KEYS.eventHead(handle.id)))!) as {
      sequence: number;
    };
    expect(headAfter.sequence).toBeGreaterThanOrEqual(headBefore.sequence);

    const log = new EventLog(storage, handle.id);
    expect(await log.verify()).toEqual({ valid: true });

    engine[Symbol.dispose]();
  });

  it('replayTo sets compactedBefore whenever a watermark exists (below AND above it)', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 2 } });
    registerCountingWorkflow(engine, 6);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    const watermark = await readEventLogWatermark(storage, handle.id);
    expect(watermark).not.toBeNull();
    const boundary = watermark!.sequence;

    const below = await engine.replayTo(handle.id, Math.max(boundary - 1, 1));
    const above = await engine.replayTo(handle.id, boundary + 1);
    expect(below?.compactedBefore).toBe(boundary);
    expect(above?.compactedBefore).toBe(boundary);
    expect(above?.accumulatedResults.map(([step]) => step)).toContain(0);

    engine[Symbol.dispose]();
  });

  it('replayTo omits compactedBefore when nothing was compacted', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    registerCountingWorkflow(engine, 3);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    const replay = await engine.replayTo(handle.id, 2);
    expect(replay?.compactedBefore).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('feed replay from a cursor below the watermark emits a compaction boundary then survivors', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 2 } });
    registerCountingWorkflow(engine, 6);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    const watermark = await readEventLogWatermark(storage, handle.id);
    const boundary = watermark!.sequence;

    const records: Array<{ kind: string; sequence: number; payload: unknown }> = [];
    for await (const record of engine.replayWorkflowFeed(handle.id, 'events', -1)) {
      records.push({ kind: record.kind, sequence: record.sequence, payload: record.payload });
    }

    // The marker sits at the LAST truncated sequence (boundary - 1) so a cursor
    // consumer that persists it resumes at `boundary` without skipping it.
    expect(records[0]!.kind).toBe(COMPACTION_BOUNDARY_KIND);
    expect(records[0]!.sequence).toBe(boundary - 1);
    expect(records[0]!.payload).toMatchObject({ compactedBefore: boundary });
    // The first real record after the marker is exactly the watermark sequence,
    // and nothing below it leaks through.
    expect(records[1]!.sequence).toBe(boundary);
    expect(records.slice(1).every((r) => r.sequence >= boundary)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('feed replay from a cursor at/above the watermark emits no boundary marker', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { retentionWindow: 2 } });
    registerCountingWorkflow(engine, 6);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    const watermark = await readEventLogWatermark(storage, handle.id);
    const boundary = watermark!.sequence;

    for (const cursor of [boundary, boundary + 1]) {
      const kinds: string[] = [];
      for await (const record of engine.replayWorkflowFeed(handle.id, 'events', cursor)) {
        kinds.push(record.kind);
      }
      expect(kinds.includes(COMPACTION_BOUNDARY_KIND)).toBe(false);
    }

    engine[Symbol.dispose]();
  });

  it('invokes a configured ArchiveAdapter once per compaction with the deleted range', async () => {
    const storage = new MemoryStorage();
    const stored: Array<{ workflowId: string; key: string; entries: Uint8Array[] }> = [];
    const adapter: ArchiveAdapter = {
      async store(workflowId, key, bytes) {
        stored.push({ workflowId, key, entries: decode(bytes) as Uint8Array[] });
      },
    };
    const engine = new Engine({ storage, history: { retentionWindow: 1 }, archive: adapter });
    registerCountingWorkflow(engine, 4);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((s) => s.workflowId === handle.id)).toBe(true);
    expect(stored.every((s) => /^events:\d+-\d+$/.test(s.key))).toBe(true);
    // Archived bytes deserialize to real event-log records.
    const firstArchived = decode(stored[0]!.entries[0]!) as Record<string, unknown>;
    expect(firstArchived['type']).toBe('workflow:checkpoint');

    engine[Symbol.dispose]();
  });

  it('does not invoke the adapter when nothing is compacted', async () => {
    const storage = new MemoryStorage();
    const store = mock(async () => {});
    const engine = new Engine({ storage, archive: { store } }); // no retentionWindow
    registerCountingWorkflow(engine, 3);
    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    expect(store).not.toHaveBeenCalled();
    engine[Symbol.dispose]();
  });

  it('a rejecting or throwing adapter never breaks checkpoint commit', async () => {
    const storage = new MemoryStorage();
    const rejecting: ArchiveAdapter = {
      store: () => Promise.reject(new Error('archive backend down')),
    };
    const engine = new Engine({ storage, history: { retentionWindow: 1 }, archive: rejecting });
    registerCountingWorkflow(engine, 4);
    const handle = await engine.start('counting', null);
    await expect(handle.result()).resolves.toBe('done');
    await flush();

    // Checkpoint still durable, log still verifiable despite archive failure.
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();
    const log = new EventLog(storage, handle.id);
    expect(await log.verify()).toEqual({ valid: true });
    engine[Symbol.dispose]();

    const throwing: ArchiveAdapter = {
      store: () => {
        throw new Error('synchronous archive failure');
      },
    };
    const storage2 = new MemoryStorage();
    const engine2 = new Engine({
      storage: storage2,
      history: { retentionWindow: 1 },
      archive: throwing,
    });
    registerCountingWorkflow(engine2, 4);
    const handle2 = await engine2.start('counting', null);
    await expect(handle2.result()).resolves.toBe('done');
    await flush();
    expect(await storage2.get(KEYS.checkpoint(handle2.id))).not.toBeNull();
    engine2[Symbol.dispose]();
  });
});
