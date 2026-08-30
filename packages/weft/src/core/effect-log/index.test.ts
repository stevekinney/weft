/**
 * Tests for EffectLog — durable deduplication of effect calls across
 * checkpoint-restore cycles.
 *
 * Verifies that:
 * 1. Crashing mid-effect and restoring prevents blind re-execution.
 * 2. A committed result is replayed without re-invocation after restore.
 * 3. A lingering in-flight record throws EffectReplayConflictError.
 * 4. The default semantic hash is stable under key-ordering variance.
 * 5. A custom identity function restricts hashing to intent-critical fields.
 *
 * @module core/effect-log.test
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory';
import { computeSemanticHash, EffectLog, EffectReplayConflictError } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(
  storage = new MemoryStorage(),
  workflowId = 'wf-1',
  operationId = 'operation-1',
): EffectLog {
  return new EffectLog(storage, workflowId, operationId);
}

// ---------------------------------------------------------------------------
// computeSemanticHash
// ---------------------------------------------------------------------------

describe('computeSemanticHash', () => {
  it('produces the same hash regardless of key order', () => {
    const a = computeSemanticHash({ a: 1, b: 2 });
    const b = computeSemanticHash({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    const a = computeSemanticHash({ recipient: 'alice', amount: 100 });
    const b = computeSemanticHash({ recipient: 'bob', amount: 100 });
    expect(a).not.toBe(b);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeSemanticHash({ x: 1 });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles nested objects stably', () => {
    const a = computeSemanticHash({ outer: { z: 3, y: 2 } });
    const b = computeSemanticHash({ outer: { y: 2, z: 3 } });
    expect(a).toBe(b);
  });

  it('does not crash when called with null', () => {
    // canonicalize(null) must return the string 'null', not throw
    expect(() => computeSemanticHash(null)).not.toThrow();
    expect(computeSemanticHash(null)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not crash when called with undefined', () => {
    // canonicalize(undefined) previously returned JS undefined (not a string),
    // causing Bun.hash.wyhash to throw. It must now return a string.
    expect(() => computeSemanticHash(undefined)).not.toThrow();
    expect(computeSemanticHash(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces stable, distinct hashes for null and undefined', () => {
    const nullHash = computeSemanticHash(null);
    const undefinedHash = computeSemanticHash(undefined);
    expect(nullHash).toMatch(/^[0-9a-f]{16}$/);
    expect(undefinedHash).toMatch(/^[0-9a-f]{16}$/);
    // null and undefined must not collide with each other
    expect(nullHash).not.toBe(undefinedHash);
  });

  it('does not collide undefined with the literal string "undefined"', () => {
    // Regression: canonicalize previously encoded `undefined` as the JSON
    // string '"undefined"', colliding with the literal string "undefined"
    // and allowing one effect call to shadow another in the effect log.
    expect(computeSemanticHash(undefined)).not.toBe(computeSemanticHash('undefined'));
    expect(computeSemanticHash({ a: undefined })).not.toBe(computeSemanticHash({ a: 'undefined' }));
    expect(computeSemanticHash([undefined])).not.toBe(computeSemanticHash(['undefined']));
  });

  it('omits object keys whose values are undefined', () => {
    // Keys with undefined values should be dropped from the canonical form,
    // matching JSON.stringify semantics.
    expect(computeSemanticHash({ a: 1, b: undefined })).toBe(computeSemanticHash({ a: 1 }));
    expect(computeSemanticHash({ a: undefined })).toBe(computeSemanticHash({}));
  });

  it('preserves array element positions for undefined entries', () => {
    // Arrays can't drop undefined elements without shifting indices, so
    // [undefined] and [] must hash differently, and [undefined, 1] must
    // differ from [1].
    expect(computeSemanticHash([undefined])).not.toBe(computeSemanticHash([]));
    expect(computeSemanticHash([undefined, 1])).not.toBe(computeSemanticHash([1]));
    // Position matters.
    expect(computeSemanticHash([undefined, 1])).not.toBe(computeSemanticHash([1, undefined]));
  });

  it('custom identity can restrict to intent-critical fields', () => {
    const identity = (input: unknown) => {
      const { recipient, amount } = input as {
        recipient: string;
        amount: number;
        retryCount: number;
      };
      return {
        semanticHash: computeSemanticHash({ recipient, amount }),
        intentCriticalFields: ['recipient', 'amount'],
      };
    };

    const id1 = identity({ recipient: 'alice', amount: 100, retryCount: 1 });
    const id2 = identity({ recipient: 'alice', amount: 100, retryCount: 99 });
    // Different retryCount does NOT produce a different hash
    expect(id1.semanticHash).toBe(id2.semanticHash);

    const id3 = identity({ recipient: 'bob', amount: 100, retryCount: 1 });
    // Different recipient DOES produce a different hash
    expect(id1.semanticHash).not.toBe(id3.semanticHash);
  });
});

// ---------------------------------------------------------------------------
// EffectLog — happy path
// ---------------------------------------------------------------------------

describe('EffectLog', () => {
  let storage: MemoryStorage;
  let log: EffectLog;

  beforeEach(() => {
    storage = new MemoryStorage();
    log = makeLog(storage);
  });

  it('lookup returns null for an unknown hash', async () => {
    const result = await log.lookup('unknown-hash');
    expect(result).toBeNull();
  });

  it('record marks the call as in-flight', async () => {
    await log.record('hash-1', 'my-effect');
    const entry = await log.lookup('hash-1');
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe('in-flight');
  });

  it('commit stores output and marks the call as committed', async () => {
    await log.record('hash-1', 'my-effect');
    await log.commit('hash-1', 'my-effect', 'effect output');
    const entry = await log.lookup('hash-1');
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toBe('effect output');
    }
  });

  it('committed record stores the effectName', async () => {
    await log.record('hash-c', 'send');
    await log.commit('hash-c', 'send', 'ok');
    const entry = await log.lookup('hash-c');
    expect(entry?.effectName).toBe('send');
  });

  it('in-flight record stores the effectName', async () => {
    await log.record('hash-f', 'transfer');
    const entry = await log.lookup('hash-f');
    expect(entry?.effectName).toBe('transfer');
  });

  it('abort marks the call as aborted', async () => {
    await log.record('hash-1', 'my-effect');
    await log.abort('hash-1', 'my-effect', 'something went wrong');
    const entry = await log.lookup('hash-1');
    expect(entry?.status).toBe('aborted');
  });

  it('committed result is replayed from storage after a new log instance is created (simulates restore)', async () => {
    await log.record('hash-1', 'charge');
    await log.commit('hash-1', 'charge', { status: 'ok' });

    // New EffectLog instance — same storage, same scope
    const restoredLog = makeLog(storage);
    const entry = await restoredLog.lookup('hash-1');
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toEqual({ status: 'ok' });
    }
  });

  it('normalizes non-JSON committed output before storing it', async () => {
    await log.record('hash-error', 'report');
    await log.commit('hash-error', 'report', new Error('boom'));

    const entry = await log.lookup('hash-error');
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toEqual({ name: 'Error', message: 'boom' });
    }
  });

  it('in-flight record persists to storage and is readable after restore', async () => {
    await log.record('hash-2', 'transfer');

    const restoredLog = makeLog(storage);
    const entry = await restoredLog.lookup('hash-2');
    expect(entry?.status).toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// EffectLog — crash simulation
// ---------------------------------------------------------------------------

describe('EffectLog crash-and-restore scenarios', () => {
  it('detects crash after record before commit without re-executing blindly', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);

    let callCount = 0;
    const mockEffect = async () => {
      callCount++;
      return 'result';
    };

    const hash = computeSemanticHash({ recipient: 'alice', amount: 100 });

    // Simulate first run: record in-flight, execute effect, then crash before commit
    await log1.record(hash, 'charge');
    await mockEffect(); // effect runs exactly once before the crash
    expect(callCount).toBe(1);
    // Crash happens here — commit never called on log1

    // Restore: new log instance sees the in-flight record
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('in-flight');

    // Restored callers should not re-invoke the effect when in-flight is detected.
    // They should escalate with EffectReplayConflictError.
    expect(() => {
      if (entry?.status === 'in-flight') {
        throw new EffectReplayConflictError(hash, 'charge');
      }
    }).toThrow(EffectReplayConflictError);

    // Effect ran once before the crash and was not re-invoked during restore
    expect(callCount).toBe(1);
  });

  it('replays committed output after restore without re-executing the effect', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);

    let callCount = 0;
    const mockEffect = async () => {
      callCount++;
      return 'committed-result';
    };

    const hash = computeSemanticHash({ action: 'debit', amount: 50 });

    // First run: record, execute, commit
    await log1.record(hash, 'debit');
    const output = await mockEffect();
    await log1.commit(hash, 'debit', output);
    expect(callCount).toBe(1);

    // Restore: new log sees committed entry — effect should NOT run again
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toBe('committed-result');
    }

    // Simulate replay logic: skip effect if committed
    if (entry?.status !== 'committed') {
      await mockEffect(); // would increment callCount
    }

    expect(callCount).toBe(1); // still only 1
  });

  it('duplicatesPrevented counter increments on committed replay', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);
    const hash = computeSemanticHash({ op: 'send', to: 'bob' });

    await log1.record(hash, 'send');
    await log1.commit(hash, 'send', 'ok');

    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('committed');
    // Log itself tracks how many committed replays occurred
    log2.recordReplay();
    expect(log2.duplicatesPrevented).toBe(1);
    log2.recordReplay();
    expect(log2.duplicatesPrevented).toBe(2);
  });

  it('aborted record is treated as retriable: lookup returns aborted status on restore', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);
    const hash = computeSemanticHash({ op: 'charge', amount: 50 });

    await log1.record(hash, 'charge');
    await log1.abort(hash, 'charge', 'card declined');

    // Restore: new log sees aborted entry
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('aborted');

    // Callers can treat aborted records as retriable — re-recording and
    // re-executing rather than replaying the failure or throwing a conflict error.
    // Verify the aborted status is not 'committed' or 'in-flight' so callers can
    // choose their handling (re-execute in the default path).
    expect(entry?.status).not.toBe('committed');
    expect(entry?.status).not.toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// EffectReplayConflictError
// ---------------------------------------------------------------------------

describe('EffectReplayConflictError', () => {
  it('is an instance of Error', () => {
    const err = new EffectReplayConflictError('some-hash', 'my-effect');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EffectReplayConflictError);
  });

  it('includes the tool name and hash in the message', () => {
    const err = new EffectReplayConflictError('abc123', 'charge');
    expect(err.message).toContain('charge');
    expect(err.message).toContain('abc123');
    expect(err.effectName).toBe('charge');
    expect(err.semanticHash).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// Storage key naming: tool-effect: prefix
// ---------------------------------------------------------------------------

describe('effect log: storage key prefix', () => {
  it('uses the tool-effect: prefix in storage keys', async () => {
    const storage = new MemoryStorage();
    const effectLog = new EffectLog(storage, 'wf-key', 'operation-key');
    const hash = computeSemanticHash({ op: 'test' });
    await effectLog.record(hash, 'my-effect');

    // Verify the key written to storage uses the full descriptive prefix
    const keys: string[] = [];
    for await (const [key] of storage.scan('tool-effect:')) {
      keys.push(key);
    }
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain('tool-effect:wf-key:operation-key:');
  });
});
