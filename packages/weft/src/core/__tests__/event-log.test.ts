/**
 * Tests for EventLog: append, scan, replay, verify, and co-write atomicity.
 */

import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { readEventHead } from '../event-log-shared.ts';
import { verifyEventLog } from '../event-log-verify.ts';
import type { WorkflowLogEntry } from '../event-log.ts';
import { EMPTY_EVENT_HEAD, EventLog } from '../event-log.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStorage(): MemoryStorage {
  return new MemoryStorage();
}

function makeLog(storage: MemoryStorage, workflowId = 'wf-test'): EventLog {
  return new EventLog(storage, workflowId);
}

async function collectScan(
  log: EventLog,
  options?: { fromSequence?: number },
): Promise<WorkflowLogEntry[]> {
  const results: WorkflowLogEntry[] = [];
  for await (const entry of log.scan(options)) {
    results.push(entry);
  }
  return results;
}

// ---------------------------------------------------------------------------
// append()
// ---------------------------------------------------------------------------

describe('EventLog.append()', () => {
  it('writes the first entry with sequence 0 and genesis prevHash', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const { sequence } = await log.append({ type: 'test:event', payload: { x: 1 } });

    expect(sequence).toBe(0);

    const entries = await collectScan(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sequence).toBe(0);
    expect(entries[0]!.prevHash).toBe('0000000000000000');
    expect(entries[0]!.type).toBe('test:event');
    expect(entries[0]!.payload).toEqual({ x: 1 });
    expect(entries[0]!.workflowId).toBe('wf-test');
  });

  it('assigns monotonically increasing sequence numbers', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const r0 = await log.append({ type: 'a', payload: null });
    const r1 = await log.append({ type: 'b', payload: null });
    const r2 = await log.append({ type: 'c', payload: null });

    expect(r0.sequence).toBe(0);
    expect(r1.sequence).toBe(1);
    expect(r2.sequence).toBe(2);
  });

  it('sets prevHash to the hash of the previous entry bytes for subsequent entries', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'first', payload: 'a' });
    await log.append({ type: 'second', payload: 'b' });

    const entries = await collectScan(log);
    expect(entries[0]!.prevHash).toBe('0000000000000000');
    // Second entry's prevHash must differ from genesis (it hashes real bytes).
    expect(entries[1]!.prevHash).not.toBe('0000000000000000');
    expect(typeof entries[1]!.prevHash).toBe('string');
    expect(entries[1]!.prevHash).toHaveLength(16);
  });

  it('returns the hash of the appended entry', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const { hash } = await log.append({ type: 'evt', payload: 42 });

    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(16);
  });

  it('accumulates writes into batchOperations when provided', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const operations: import('../../storage/interface.ts').BatchOperation[] = [];
    const { newHead } = await log.append({ type: 'batched', payload: 'yes' }, operations);

    // newHead reflects the in-flight state even before the batch flushes.
    expect(newHead.sequence).toBe(0);
    expect(newHead.lastHash).toHaveLength(16);

    // Nothing written to storage yet — the batch was not flushed.
    const entries = await collectScan(log);
    expect(entries).toHaveLength(0);

    // After flushing, the entry appears.
    await storage.batch(operations);
    const afterFlush = await collectScan(log);
    expect(afterFlush).toHaveLength(1);
    expect(afterFlush[0]!.type).toBe('batched');
  });
});

// ---------------------------------------------------------------------------
// scan()
// ---------------------------------------------------------------------------

describe('EventLog.scan()', () => {
  it('returns entries in ascending sequence order', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'a', payload: 1 });
    await log.append({ type: 'b', payload: 2 });
    await log.append({ type: 'c', payload: 3 });

    const entries = await collectScan(log);
    expect(entries.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('honours fromSequence option', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'a', payload: 1 });
    await log.append({ type: 'b', payload: 2 });
    await log.append({ type: 'c', payload: 3 });

    const entries = await collectScan(log, { fromSequence: 1 });
    expect(entries.map((e) => e.type)).toEqual(['b', 'c']);
  });

  it('returns an empty iterable for a log with no entries', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const entries = await collectScan(log);
    expect(entries).toHaveLength(0);
  });

  it('does not yield the head record', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'x', payload: null });

    const entries = await collectScan(log);
    // Only one typed entry, not two (no head record leaking through).
    expect(entries).toHaveLength(1);
  });

  it('returns an empty iterable when fromSequence is beyond the last entry', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'only', payload: null });

    const entries = await collectScan(log, { fromSequence: 99 });
    expect(entries).toHaveLength(0);
  });

  it('reads entries for workflow ids that require key encoding', async () => {
    const storage = makeStorage();
    const workflowId = 'wf:events/with spaces';
    const log = makeLog(storage, workflowId);

    await log.append({ type: 'encoded', payload: { ok: true } });

    const entries = await collectScan(log);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.workflowId).toBe(workflowId);
    expect(await storage.get(KEYS.event(workflowId, 0))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replay()
// ---------------------------------------------------------------------------

describe('EventLog.replay()', () => {
  it('returns all entries up to and including toStep', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'step0', payload: 'a' });
    await log.append({ type: 'step1', payload: 'b' });
    await log.append({ type: 'step2', payload: 'c' });

    const replayed = await log.replay(1);
    expect(replayed).toHaveLength(2);
    expect(replayed.map((e) => e.type)).toEqual(['step0', 'step1']);
  });

  it('returns only the first entry when toStep is 0', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'first', payload: 1 });
    await log.append({ type: 'second', payload: 2 });

    const replayed = await log.replay(0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.type).toBe('first');
  });

  it('returns all entries when toStep equals the last sequence', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'a', payload: null });
    await log.append({ type: 'b', payload: null });

    const replayed = await log.replay(1);
    expect(replayed).toHaveLength(2);
  });

  it('returns an empty list when toStep is below 0', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'a', payload: null });

    const replayed = await log.replay(-1);
    expect(replayed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

describe('EventLog.verify()', () => {
  it('returns { valid: true } for an unmodified log', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'e0', payload: 'hello' });
    await log.append({ type: 'e1', payload: 'world' });
    await log.append({ type: 'e2', payload: '!' });

    const result = await log.verify();
    expect(result).toEqual({ valid: true });
  });

  it('returns { valid: true } for an empty log', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const result = await log.verify();
    expect(result.valid).toBe(true);
  });

  it('returns { valid: true } for a single-entry log', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'only', payload: null });

    const result = await log.verify();
    expect(result.valid).toBe(true);
  });

  it('verifies logs for workflow ids that require key encoding', async () => {
    const storage = makeStorage();
    const log = makeLog(storage, 'wf:verify/with spaces');

    await log.append({ type: 'encoded', payload: 1 });
    await log.append({ type: 'encoded', payload: 2 });

    const result = await log.verify();

    expect(result).toEqual({ valid: true });
  });

  it('detects tampering and returns { valid: false, firstInvalidSequence: N }', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    await log.append({ type: 'legit', payload: 1 });
    await log.append({ type: 'legit', payload: 2 });
    await log.append({ type: 'legit', payload: 3 });

    // Tamper: overwrite entry at sequence 1 with different content.
    const tamperedEntry = {
      type: 'tampered',
      workflowId: 'wf-test',
      sequence: 1,
      prevHash: '0000000000000000', // wrong hash
      payload: 'TAMPERED',
      timestamp: Date.now(),
    };
    await storage.put(KEYS.event('wf-test', 1), encode(tamperedEntry));

    const result = await log.verify();
    // Entry 1 carries prevHash='0000000000000000' (genesis) but the verifier
    // expects it to match hash(entry0_bytes). That mismatch is detected first.
    expect(result).toEqual({ valid: false, firstInvalidSequence: 1 });
  });

  it('treats an invalid stored head record as an empty head', async () => {
    const storage = makeStorage();
    await storage.put(KEYS.eventHead('wf-invalid-head'), encode({ nope: true }));

    await expect(readEventHead(storage, 'wf-invalid-head')).resolves.toEqual(EMPTY_EVENT_HEAD);
  });

  it('reports corruption when the head says the log is empty but surviving entries exist', async () => {
    const storage = makeStorage();
    const log = makeLog(storage, 'wf-head-mismatch');
    await log.append({ type: 'event', payload: 'x' });
    await storage.put(KEYS.eventHead('wf-head-mismatch'), encode(EMPTY_EVENT_HEAD));

    await expect(verifyEventLog(storage, 'wf-head-mismatch')).resolves.toEqual({
      valid: false,
      firstInvalidSequence: 0,
    });
  });

  it('reports corruption when the head claims a surviving tail but the scan is empty', async () => {
    const storage = makeStorage();
    await storage.put(
      KEYS.eventHead('wf-missing-tail'),
      encode({ sequence: 3, lastHash: 'abcdef0123456789' }),
    );

    await expect(verifyEventLog(storage, 'wf-missing-tail')).resolves.toEqual({
      valid: false,
      firstInvalidSequence: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// appendToBatch() (synchronous fast path)
// ---------------------------------------------------------------------------

describe('EventLog.appendToBatch()', () => {
  it('synchronously pushes entry and head writes onto the batch, returning the new head', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const operations: import('../../storage/interface.ts').BatchOperation[] = [];
    const { newHead, timestamp } = log.appendToBatch(
      { type: 'sync:event', payload: 42 },
      operations,
      EMPTY_EVENT_HEAD,
    );

    // Two operations: event entry + head record.
    expect(operations).toHaveLength(2);
    const keys = operations.map((o) => o.key);
    expect(keys.some((k) => k.startsWith('ev:wf-test:'))).toBe(true);
    expect(keys.some((k) => k === KEYS.eventHead('wf-test'))).toBe(true);

    // newHead reflects the committed state.
    expect(newHead.sequence).toBe(0);
    expect(typeof newHead.lastHash).toBe('string');
    expect(newHead.lastHash).toHaveLength(16);
    // timestamp matches the entry's wall-clock stamp (non-negative).
    // `Date.now()` can be stubbed to `0` in tests that inject a
    // fixed clock, so the assertion must accept zero.
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThanOrEqual(0);

    // Nothing in storage yet — batch not flushed.
    const entries = await collectScan(log);
    expect(entries).toHaveLength(0);

    // After flush, the entry appears.
    await storage.batch(operations);
    const afterFlush = await collectScan(log);
    expect(afterFlush).toHaveLength(1);
    expect(afterFlush[0]!.type).toBe('sync:event');
    expect(afterFlush[0]!.prevHash).toBe('0000000000000000');
    expect(afterFlush[0]!.timestamp).toBe(timestamp);
  });

  it('chains hashes correctly across multiple appendToBatch calls', async () => {
    const storage = makeStorage();
    const log = makeLog(storage);

    const ops: import('../../storage/interface.ts').BatchOperation[] = [];
    let head = EMPTY_EVENT_HEAD;
    head = log.appendToBatch({ type: 'a', payload: 1 }, ops, head).newHead;
    head = log.appendToBatch({ type: 'b', payload: 2 }, ops, head).newHead;
    head = log.appendToBatch({ type: 'c', payload: 3 }, ops, head).newHead;

    await storage.batch(ops);

    const result = await log.verify();
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: co-write with checkpoint
// ---------------------------------------------------------------------------

describe('EventLog atomicity', () => {
  it('includes both event and checkpoint writes in a single batch call', async () => {
    const inner = makeStorage();

    const batchCalls: import('../../storage/interface.ts').BatchOperation[][] = [];
    const spy = mock((...args: Parameters<typeof inner.batch>) => {
      batchCalls.push(args[0]);
      return inner.batch(...args);
    });

    // Proxy storage that intercepts batch.
    const proxied = new Proxy(inner, {
      get(target, property) {
        if (property === 'batch') return spy;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const log = new EventLog(proxied, 'wf-atomic');

    // Simulate what the engine does: synchronously build a batch that includes
    // both the checkpoint write and the event log write, then flush once.
    const { encode: encodeValue } = await import('../codec.ts');

    const operations: import('../../storage/interface.ts').BatchOperation[] = [
      {
        type: 'put',
        key: KEYS.checkpoint('wf-atomic'),
        value: encodeValue({ step: 1, workflowId: 'wf-atomic' }),
      },
    ];

    // appendToBatch is synchronous — exactly mirrors what #persistCheckpoint does.
    log.appendToBatch(
      { type: 'workflow:checkpoint', payload: { step: 1 } },
      operations,
      EMPTY_EVENT_HEAD,
    );
    await proxied.batch(operations);

    // Exactly one batch call.
    expect(batchCalls).toHaveLength(1);

    const ops = batchCalls[0]!;
    const keys = ops.map((o) => o.key);

    // The batch must include both the checkpoint key and an event key.
    const hasCheckpoint = keys.some((k) => k === KEYS.checkpoint('wf-atomic'));
    const hasEvent = keys.some((k) => k.startsWith('ev:wf-atomic:'));

    expect(hasCheckpoint).toBe(true);
    expect(hasEvent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State reconstruction via replay
// ---------------------------------------------------------------------------

describe('State reconstruction from replay', () => {
  it('replays events and reconstructed payload list deeply equals live checkpoint state', async () => {
    const storage = makeStorage();
    const log = makeLog(storage, 'wf-reconstruct');

    // Simulate a workflow that advances through three steps, each appending a checkpoint event.
    const steps = [
      { step: 0, locals: { count: 0 } },
      { step: 1, locals: { count: 1 } },
      { step: 2, locals: { count: 2 } },
    ];

    for (const stepData of steps) {
      await log.append({ type: 'workflow:checkpoint', payload: stepData });
    }

    // The "live checkpoint" is the last step's state.
    const liveCheckpoint = steps[steps.length - 1];

    // Replay all events and assert the final payload matches the live checkpoint.
    const replayed = await log.replay(2);
    expect(replayed).toHaveLength(3);

    const lastReplayedPayload = replayed[replayed.length - 1]!.payload;
    expect(lastReplayedPayload).toEqual(liveCheckpoint);
  });

  it('replay of partial steps produces a subset equal to historical checkpoint state', async () => {
    const storage = makeStorage();
    const log = makeLog(storage, 'wf-partial');

    const checkpoints = [
      { step: 0, locals: { value: 'initial' } },
      { step: 1, locals: { value: 'after-step-1' } },
      { step: 2, locals: { value: 'after-step-2' } },
    ];

    for (const cp of checkpoints) {
      await log.append({ type: 'workflow:checkpoint', payload: cp });
    }

    // Replay only up to step 1.
    const replayed = await log.replay(1);
    expect(replayed).toHaveLength(2);
    expect(replayed[1]!.payload).toEqual(checkpoints[1]);
  });
});
